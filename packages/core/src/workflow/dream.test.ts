import { createDb, type Db, dreamNotes, memories, tasks, toolCalls } from '@assistant/db';
import { and, eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../chat.js';
import type { ModelRouter } from '../model-router/router.js';
import { purgeStaleDreamNotes, recentDreamNotes, runDream } from './dream.js';
import { enqueueTask } from './machine.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

const fakeRouter = {
  async embed(texts: string[]) {
    return texts.map(() => new Array(1536).fill(0.02));
  },
  async object() {
    return {
      ok: true as const,
      modelId: 'fake',
      degraded: false,
      object: {
        footnotes: [
          'xtest-dream: the browse of the news site failed on the selector — try a range read',
        ],
        hypotheses: [
          {
            subject: 'owner',
            claim: 'xtest-dream owner declines meetings before 10am',
            confidence: 0.3,
          },
        ],
        anticipations: ['xtest-dream: pre-staged tomorrow’s standup notes'],
      },
    };
  },
} as unknown as ModelRouter;

describe('dreaming (offline cognition)', () => {
  let db: Db;
  let dbUp = false;
  let agentId: string;
  let taskId: string;

  async function cleanup() {
    await db.delete(memories).where(like(memories.content, '%xtest-dream%'));
    await db.delete(dreamNotes).where(like(dreamNotes.content, '%xtest-dream%'));
    if (taskId) {
      await db.delete(toolCalls).where(eq(toolCalls.taskId, taskId));
      await db.delete(tasks).where(eq(tasks.id, taskId));
    }
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    try {
      agentId = (await getAgent(db)).id;
      dbUp = true;
      await cleanup();
      const { task } = await enqueueTask(db, {
        event: { source: 'internal', agentId, trust: 'assistant', payload: { note: 'xtest' } },
        type: 'adhoc',
      });
      taskId = task.id;
      // A failed tool call gives the dream something to reflect on.
      await db.insert(toolCalls).values({
        taskId,
        step: 0,
        toolName: 'xtest-dream-tool',
        args: {},
        risk: 'autonomous',
        status: 'failed',
        error: 'selector not found',
      });
    } catch {
      console.warn('dream.test: database unreachable — skipping');
    }
  });

  afterAll(async () => {
    if (dbUp) await cleanup();
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
  });

  it('reflects on failures into footnotes, quarantined hypotheses, and dream notes', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const r = await runDream({ db, router: fakeRouter });
    expect(r.footnotes).toBeGreaterThanOrEqual(1);
    expect(r.hypotheses).toBeGreaterThanOrEqual(1);
    expect(r.anticipations).toBeGreaterThanOrEqual(1);

    // The behavioral hypothesis is a LOW-CONFIDENCE, QUARANTINED memory awaiting review.
    const [hyp] = await db
      .select()
      .from(memories)
      .where(and(eq(memories.source, 'dream'), like(memories.content, '%xtest-dream%')));
    expect(hyp?.quarantined).toBe(true);
    expect(hyp?.originTrust).toBe('assistant');
    expect(Number(hyp?.confidence)).toBeLessThanOrEqual(0.4);
    expect(hyp?.expiresAt).not.toBeNull();

    // Owner-facing notes land in dream_notes and are fresh.
    const notes = await recentDreamNotes(db, agentId);
    const mine = notes.filter((n) => n.content.includes('xtest-dream'));
    expect(mine.some((n) => n.kind === 'footnote')).toBe(true);
    expect(mine.some((n) => n.kind === 'anticipation')).toBe(true);
  });

  it('purges dream notes past their inspection window', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await db.insert(dreamNotes).values({
      agentId,
      kind: 'footnote',
      content: 'xtest-dream stale note',
      expiresAt: new Date(Date.now() - 1000),
    });
    const purged = await purgeStaleDreamNotes(db);
    expect(purged).toBeGreaterThanOrEqual(1);
    const remaining = await recentDreamNotes(db, agentId);
    expect(remaining.some((n) => n.content === 'xtest-dream stale note')).toBe(false);
  });
});
