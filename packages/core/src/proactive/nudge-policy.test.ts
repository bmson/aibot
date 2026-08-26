import { createDb, type Db, notificationPrefs, proactivePings } from '@assistant/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../chat.js';
import { countHeldPings, evaluateOutOfBandPing, purgeStaleProactivePings } from './nudge-policy.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

// The seeded agent runs on Atlantic/Reykjavik — UTC year-round, no DST, so a
// fixed UTC clock doubles as the owner's local one.
const MIDDAY = new Date('2026-08-25T12:00:00Z');
const LATE_NIGHT = new Date('2026-08-25T23:30:00Z');

describe('nudge policy (integration)', () => {
  let db: Db;
  let dbUp = false;
  let agent: { id: string; timezone: string };

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    try {
      agent = await getAgent(db);
      dbUp = true;
    } catch {
      console.warn('nudge-policy.test: database unreachable — skipping');
    }
  });

  afterEach(async () => {
    if (!dbUp) return;
    await db.delete(notificationPrefs).where(eq(notificationPrefs.agentId, agent.id));
    await db.delete(proactivePings).where(eq(proactivePings.agentId, agent.id));
  });

  afterAll(async () => {
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
  });

  async function setPrefs(prefs: {
    quietStartMin?: number | null;
    quietEndMin?: number | null;
    ambientDailyCap?: number | null;
  }) {
    await db.delete(notificationPrefs).where(eq(notificationPrefs.agentId, agent.id));
    await db.insert(notificationPrefs).values({
      agentId: agent.id,
      quietStartMin: prefs.quietStartMin ?? null,
      quietEndMin: prefs.quietEndMin ?? null,
      ambientDailyCap: prefs.ambientDailyCap ?? null,
    });
  }

  it('delivers everything when no prefs row exists (shipped default)', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const decision = await evaluateOutOfBandPing(db, agent, {
      urgency: 'ambient',
      now: LATE_NIGHT,
    });
    expect(decision).toEqual({ deliver: true });
  });

  it('never gates an interrupt, even inside quiet hours', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await setPrefs({ quietStartMin: 22 * 60, quietEndMin: 7 * 60, ambientDailyCap: 1 });
    const decision = await evaluateOutOfBandPing(db, agent, {
      urgency: 'interrupt',
      now: LATE_NIGHT,
    });
    expect(decision.deliver).toBe(true);
  });

  it('holds ambient pings inside an overnight quiet window', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await setPrefs({ quietStartMin: 22 * 60, quietEndMin: 7 * 60 });
    const night = await evaluateOutOfBandPing(db, agent, { urgency: 'ambient', now: LATE_NIGHT });
    expect(night).toEqual({ deliver: false, reason: 'quiet-hours' });
    const day = await evaluateOutOfBandPing(db, agent, { urgency: 'ambient', now: MIDDAY });
    expect(day).toEqual({ deliver: true });
  });

  it('treats a zero-width or half-set window as off', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await setPrefs({ quietStartMin: 12 * 60, quietEndMin: 12 * 60 });
    expect(
      (await evaluateOutOfBandPing(db, agent, { urgency: 'ambient', now: MIDDAY })).deliver,
    ).toBe(true);
    await setPrefs({ quietStartMin: 22 * 60, quietEndMin: null });
    expect(
      (await evaluateOutOfBandPing(db, agent, { urgency: 'ambient', now: LATE_NIGHT })).deliver,
    ).toBe(true);
  });

  it('caps ambient pings per owner-local day; held pings do not spend the budget', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await setPrefs({ ambientDailyCap: 2 });
    const at = (plusMinutes: number) => new Date(MIDDAY.getTime() + plusMinutes * 60_000);
    expect(
      (await evaluateOutOfBandPing(db, agent, { urgency: 'ambient', now: at(0) })).deliver,
    ).toBe(true);
    expect(
      (await evaluateOutOfBandPing(db, agent, { urgency: 'ambient', now: at(1) })).deliver,
    ).toBe(true);
    // The cap is spent — everything further today is held.
    const held = await evaluateOutOfBandPing(db, agent, { urgency: 'ambient', now: at(2) });
    expect(held).toEqual({ deliver: false, reason: 'daily-cap' });
    // Held pings are not interruptions, so they cannot spend the budget either.
    expect(
      (await evaluateOutOfBandPing(db, agent, { urgency: 'ambient', now: at(3) })).deliver,
    ).toBe(false);
    // Interrupts pass even with the ambient budget exhausted.
    expect(
      (await evaluateOutOfBandPing(db, agent, { urgency: 'interrupt', now: at(4) })).deliver,
    ).toBe(true);
  });

  it('records every evaluation in the ledger and reports what was held', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await setPrefs({ quietStartMin: 22 * 60, quietEndMin: 7 * 60, ambientDailyCap: 1 });
    await evaluateOutOfBandPing(db, agent, { urgency: 'ambient', now: LATE_NIGHT });
    await evaluateOutOfBandPing(db, agent, { urgency: 'ambient', now: MIDDAY });
    await evaluateOutOfBandPing(db, agent, { urgency: 'ambient', now: MIDDAY });

    const held = await countHeldPings(db, agent.id, new Date(0));
    expect(held).toEqual({ quietHours: 1, dailyCap: 1 });

    const rows = await db.select().from(proactivePings).where(eq(proactivePings.agentId, agent.id));
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.delivered)).toHaveLength(1);
  });

  it('purges ledger rows past the retention window', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await db.insert(proactivePings).values([
      {
        agentId: agent.id,
        urgency: 'ambient',
        channel: 'out-of-band',
        delivered: true,
        createdAt: new Date('2020-01-01T00:00:00Z'),
      },
      {
        agentId: agent.id,
        urgency: 'ambient',
        channel: 'out-of-band',
        delivered: true,
      },
    ]);
    const purged = await purgeStaleProactivePings(db, 90);
    expect(purged).toBe(1);
    const remaining = await db
      .select({ id: proactivePings.id })
      .from(proactivePings)
      .where(eq(proactivePings.agentId, agent.id));
    expect(remaining).toHaveLength(1);
  });
});
