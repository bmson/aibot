import { createDb, type Db, suggestions, tasks } from '@assistant/db';
import { eq, inArray, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../chat.js';
import {
  acceptSuggestion,
  createSuggestion,
  dismissSuggestion,
  expireStaleSuggestions,
  listOpenSuggestions,
  snoozeSuggestion,
} from './suggestions.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';
const MARKER = `xtest-suggestion-${Date.now()}`;

let db: Db;
let dbUp = false;
let agentId: string;
const created: string[] = [];

async function makeSuggestion(ref: string, overrides: { expiresInMs?: number } = {}) {
  const row = await createSuggestion(db, {
    agentId,
    summary: `${MARKER} add the flight to your calendar?`,
    proposedAction: `${MARKER} Create a calendar event with no attendees for the Oslo flight.`,
    sourceRef: `${MARKER}-${ref}`,
    ...(overrides.expiresInMs !== undefined
      ? { ttlDays: overrides.expiresInMs / (24 * 3600 * 1000) }
      : {}),
  });
  if (row) created.push(row.id);
  return row;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    agentId = (await getAgent(db)).id;
    dbUp = true;
  } catch {
    console.warn('suggestions.test: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp) {
    const rows = await db
      .select({ acceptedTaskId: suggestions.acceptedTaskId })
      .from(suggestions)
      .where(like(suggestions.sourceRef, `${MARKER}%`));
    await db.delete(suggestions).where(like(suggestions.sourceRef, `${MARKER}%`));
    const taskIds = rows.map((r) => r.acceptedTaskId).filter((id): id is string => Boolean(id));
    if (taskIds.length) await db.delete(tasks).where(inArray(tasks.id, taskIds));
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('suggestions', () => {
  it('proposes the same thing only once', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // The briefing runs daily and sees the same mail window again. Re-asking a
    // question the owner already answered is how a surface gets ignored.
    const first = await makeSuggestion('dedupe');
    const second = await makeSuggestion('dedupe');
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('accepting creates work that runs tainted, and links it back', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const row = await makeSuggestion('accept');
    if (!row) throw new Error('suggestion was not created');

    const outcome = await acceptSuggestion(db, row.id);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const [task] = await db.select().from(tasks).where(eq(tasks.id, outcome.taskId));
    if (!task) throw new Error('accepted suggestion did not create a task');
    expect(task.trust).toBe('owner');
    const payload = (task.trigger as { payload: Record<string, unknown> }).payload;
    expect(payload.instruction).toContain('Oslo flight');
    // The proposal was written from a third party's email, so the work it
    // creates must not start clean — otherwise accepting would launder an
    // outward action past the approval spine.
    expect(payload.taintedOrigin).toBe(true);

    const [after] = await db.select().from(suggestions).where(eq(suggestions.id, row.id));
    expect(after?.status).toBe('accepted');
    expect(after?.acceptedTaskId).toBe(outcome.taskId);
  });

  it('cannot be accepted twice', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const row = await makeSuggestion('double');
    if (!row) throw new Error('suggestion was not created');
    const first = await acceptSuggestion(db, row.id);
    const second = await acceptSuggestion(db, row.id);
    expect(first.ok).toBe(true);
    // A double-tap or a second tab must create one task, not two.
    expect(second.ok).toBe(false);
  });

  it('dismissing closes it, and a dismissed one cannot be accepted', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const row = await makeSuggestion('dismiss');
    if (!row) throw new Error('suggestion was not created');
    expect(await dismissSuggestion(db, row.id)).toBe(true);
    expect(await dismissSuggestion(db, row.id)).toBe(false);
    const outcome = await acceptSuggestion(db, row.id);
    expect(outcome.ok).toBe(false);
  });

  it('snoozing hides it and carries the deadline out with it', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const row = await makeSuggestion('snooze');
    if (!row) throw new Error('suggestion was not created');
    const until = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    expect(await snoozeSuggestion(db, row.id, until)).toBe(true);

    const open = await listOpenSuggestions(db, agentId);
    expect(open.some((s) => s.id === row.id)).toBe(false);

    const [after] = await db.select().from(suggestions).where(eq(suggestions.id, row.id));
    // Snoozing past the original expiry must not silently drop it.
    expect(after?.expiresAt.getTime()).toBeGreaterThanOrEqual(until.getTime());
  });

  it('retires unanswered proposals instead of accumulating them', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const row = await makeSuggestion('stale');
    if (!row) throw new Error('suggestion was not created');
    await db
      .update(suggestions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(suggestions.id, row.id));

    const expired = await expireStaleSuggestions(db);
    expect(expired).toBeGreaterThanOrEqual(1);
    const [after] = await db.select().from(suggestions).where(eq(suggestions.id, row.id));
    expect(after?.status).toBe('expired');
    // An expired proposal is not a live question any more.
    expect((await acceptSuggestion(db, row.id)).ok).toBe(false);
  });
});
