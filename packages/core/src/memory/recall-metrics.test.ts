import { agents, createDb, type Db, recallMetrics } from '@assistant/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordRecallMetric } from './recall-metrics.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';
const MARKER = `xtest-recall-metrics-${Date.now()}`;

let db: Db;
let dbUp = false;
let agentId: string;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    const [agent] = await db
      .insert(agents)
      .values({
        name: 'Recall Metrics Test',
        email: `${MARKER}@example.com`,
        workspacePrefix: MARKER,
      })
      .returning({ id: agents.id });
    if (!agent) throw new Error('test agent was not created');
    agentId = agent.id;
    dbUp = true;
  } catch {
    console.warn('recall-metrics.test: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp) await db.delete(agents).where(eq(agents.id, agentId));
  await (db as unknown as { $client?: { end: () => Promise<void> } }).$client?.end?.();
});

describe('recall telemetry (integration)', () => {
  it('persists bounded retrieval counters without prompt or source content', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await recordRecallMetric(db, {
      agentId,
      path: 'executor',
      graphAttempted: true,
      graphFailed: true,
      historyFailed: true,
      graphCandidates: Number.POSITIVE_INFINITY,
      graphUsed: 2.1,
      historyTier: 'message',
      historyUsed: -3.7,
      sourceCount: 5.2,
    });
    const [row] = await db.select().from(recallMetrics).where(eq(recallMetrics.agentId, agentId));
    expect(row).toMatchObject({
      path: 'executor',
      graphAttempted: true,
      graphFailed: true,
      historyFailed: true,
      graphCandidates: 0,
      graphUsed: 2,
      historyTier: 'message',
      historyUsed: 0,
      sourceCount: 5,
    });
  });
});
