import { type Db, recallMetrics } from '@assistant/db';
import { inArray, lte, sql } from 'drizzle-orm';

export interface RecallMetricInput {
  agentId: string;
  taskId?: string;
  conversationId?: string;
  path: 'chat' | 'executor';
  graphAttempted: boolean;
  graphFailed: boolean;
  historyFailed: boolean;
  graphCandidates: number;
  graphUsed: number;
  historyTier: 'segment' | 'message' | 'none';
  historyUsed: number;
  sourceCount: number;
}

function boundedCounter(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/**
 * Record only bounded retrieval counters. Queries, source text, embeddings,
 * and prompt blocks deliberately stay out of telemetry.
 */
export async function recordRecallMetric(db: Db, input: RecallMetricInput): Promise<void> {
  await db.insert(recallMetrics).values({
    agentId: input.agentId,
    taskId: input.taskId ?? null,
    conversationId: input.conversationId ?? null,
    path: input.path,
    graphAttempted: input.graphAttempted,
    graphFailed: input.graphFailed,
    historyFailed: input.historyFailed,
    graphCandidates: boundedCounter(input.graphCandidates),
    graphUsed: boundedCounter(input.graphUsed),
    historyTier: input.historyTier,
    historyUsed: boundedCounter(input.historyUsed),
    sourceCount: boundedCounter(input.sourceCount),
  });
}

/**
 * Keep operational recall telemetry bounded without applying retention policy
 * to the underlying owner conversation or memory data.
 */
export async function purgeStaleRecallMetrics(
  db: Db,
  retentionDays = 90,
  batch = 500,
): Promise<number> {
  const days = Number.isFinite(retentionDays) ? Math.max(1, Math.trunc(retentionDays)) : 90;
  const limit = Number.isFinite(batch) ? Math.max(1, Math.trunc(batch)) : 500;
  const cutoff = sql`now() - make_interval(days => ${days})`;
  const agedRows = db
    .select({ id: recallMetrics.id })
    .from(recallMetrics)
    .where(lte(recallMetrics.createdAt, cutoff))
    .limit(limit);
  const deleted = await db
    .delete(recallMetrics)
    .where(inArray(recallMetrics.id, agedRows))
    .returning({ id: recallMetrics.id });
  return deleted.length;
}
