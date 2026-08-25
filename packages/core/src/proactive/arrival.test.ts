import { createDb, type Db, locationPings, tasks } from '@assistant/db';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../chat.js';
import { maybeEnqueueArrivalNudge } from './arrival.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

/**
 * The window is pinned to June 2020 so real (present-day) pings and tasks in
 * a dev database can never satisfy the baseline or the cooldown — the queries
 * are bounded by `capturedAt < ping.capturedAt` and `createdAt >= now-12h`.
 */
const NOW = new Date('2020-06-15T12:00:00Z');
// Downtown Reykjavík vs Kópavogur — ~7km apart, well past the 1.5km radius.
const HOME = { lat: 64.1466, lng: -21.9426 };
const AWAY = { lat: 64.1123, lng: -21.9 };

describe('maybeEnqueueArrivalNudge (integration)', () => {
  let db: Db;
  let dbUp = false;
  let agent: { id: string; timezone: string };

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    try {
      agent = await getAgent(db);
      dbUp = true;
    } catch {
      console.warn('arrival.test: database unreachable — skipping');
    }
  });

  afterEach(async () => {
    if (!dbUp) return;
    await db
      .delete(locationPings)
      .where(and(eq(locationPings.agentId, agent.id), sql`${locationPings.source} = 'xtest'`));
    await db
      .delete(tasks)
      .where(and(eq(tasks.agentId, agent.id), sql`${tasks.externalEventId} like 'arrival:%'`));
  });

  afterAll(async () => {
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
  });

  function ping(overrides: Partial<Parameters<typeof maybeEnqueueArrivalNudge>[2]> = {}) {
    return {
      lat: AWAY.lat,
      lng: AWAY.lng,
      label: 'Kópavogur',
      accuracyM: 50,
      capturedAt: NOW,
      ...overrides,
    };
  }

  async function insertBaseline(at: Date, place = HOME) {
    await db.insert(locationPings).values({
      agentId: agent.id,
      lat: String(place.lat),
      lng: String(place.lng),
      source: 'xtest',
      capturedAt: at,
    });
  }

  it('enqueues one considered nudge on a genuine arrival', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await insertBaseline(new Date(NOW.getTime() - 2 * 3600e3));

    expect(await maybeEnqueueArrivalNudge(db, agent, ping(), NOW)).toBe(true);

    const [task] = await db
      .select({ instruction: sql<string>`${tasks.trigger} -> 'payload' ->> 'instruction'` })
      .from(tasks)
      .where(and(eq(tasks.agentId, agent.id), sql`${tasks.externalEventId} like 'arrival:%'`));
    expect(task?.instruction).toContain('Kópavogur');
    expect(task?.instruction).toContain('owner.notify');
  });

  it('stays quiet when the ping is near somewhere the owner already was', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await insertBaseline(new Date(NOW.getTime() - 5 * 3600e3), AWAY);
    expect(await maybeEnqueueArrivalNudge(db, agent, ping(), NOW)).toBe(false);
  });

  it('stands down with no baseline at all (fresh install / purged history)', async (ctx) => {
    if (!dbUp) return ctx.skip();
    expect(await maybeEnqueueArrivalNudge(db, agent, ping(), NOW)).toBe(false);
  });

  it('dedupes the same place on the same day, and respects the 12h cooldown', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await insertBaseline(new Date(NOW.getTime() - 2 * 3600e3));
    expect(await maybeEnqueueArrivalNudge(db, agent, ping(), NOW)).toBe(true);
    // Replay (crash retry, duplicate ping): the idempotency key absorbs it.
    expect(await maybeEnqueueArrivalNudge(db, agent, ping(), NOW)).toBe(false);
    // Somewhere else entirely an hour later: the global cooldown holds.
    expect(
      await maybeEnqueueArrivalNudge(
        db,
        agent,
        ping({ lat: 64.8, lng: -23.5, label: 'Snæfellsnes' }),
        new Date(NOW.getTime() + 3600e3),
      ),
    ).toBe(false);
    const created = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.agentId, agent.id), sql`${tasks.externalEventId} like 'arrival:%'`));
    expect(created).toHaveLength(1);
  });

  it('ignores fixes too coarse to name a place', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await insertBaseline(new Date(NOW.getTime() - 2 * 3600e3));
    expect(await maybeEnqueueArrivalNudge(db, agent, ping({ accuracyM: 5000 }), NOW)).toBe(false);
  });
});
