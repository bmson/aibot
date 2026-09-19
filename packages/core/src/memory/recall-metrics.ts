import { type Db, recallMetrics } from '@assistant/db';
import type { RecallMetricInput, RecallMetricsRepository } from '@assistant/persistence';
import { inArray, lte, sql } from 'drizzle-orm';

export type { RecallMetricInput } from '@assistant/persistence';

function boundedCounter(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/**
 * Record only bounded retrieval counters. Queries, source text, embeddings,
 * and prompt blocks deliberately stay out of telemetry.
 */
export async function recordRecallMetric(
  db: Db | RecallMetricsRepository,
  input: RecallMetricInput,
): Promise<void> {
  const values = {
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
  };
  if ('kind' in db && db.kind === 'recall-metrics-repository') {
    await (db as RecallMetricsRepository).record({
      ...values,
      taskId: input.taskId,
      conversationId: input.conversationId,
    });
    return;
  }
  await (db as Db).insert(recallMetrics).values(values);
}

/**
 * Keep operational recall telemetry bounded without applying retention policy
 * to the underlying owner conversation or memory data.
 */
export async function purgeStaleRecallMetrics(
  db: Db | RecallMetricsRepository,
  retentionDays = 90,
  batch = 500,
): Promise<number> {
  const days = Number.isFinite(retentionDays) ? Math.max(1, Math.trunc(retentionDays)) : 90;
  const limit = Number.isFinite(batch) ? Math.max(1, Math.trunc(batch)) : 500;
  if ('kind' in db && db.kind === 'recall-metrics-repository') {
    return (db as RecallMetricsRepository).purge({
      notAfter: new Date(Date.now() - days * 86_400_000),
      limit,
    });
  }
  const postgres = db as Db;
  const cutoff = sql`now() - make_interval(days => ${days})`;
  const agedRows = postgres
    .select({ id: recallMetrics.id })
    .from(recallMetrics)
    .where(lte(recallMetrics.createdAt, cutoff))
    .limit(limit);
  const deleted = await postgres
    .delete(recallMetrics)
    .where(inArray(recallMetrics.id, agedRows))
    .returning({ id: recallMetrics.id });
  return deleted.length;
}
