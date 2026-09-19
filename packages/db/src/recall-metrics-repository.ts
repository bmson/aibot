import { historyLimit, type RecallMetricsRepository } from '@assistant/persistence';
import { inArray, lte } from 'drizzle-orm';
import type { Db } from './client.js';
import { recallMetrics } from './schema.js';

export function createPostgresRecallMetricsRepository(db: Db): RecallMetricsRepository {
  return {
    kind: 'recall-metrics-repository',
    async record(input) {
      await db.insert(recallMetrics).values(input);
    },
    async purge({ notAfter, limit }) {
      const aged = db
        .select({ id: recallMetrics.id })
        .from(recallMetrics)
        .where(lte(recallMetrics.createdAt, notAfter))
        .limit(historyLimit(limit, 500));
      const deleted = await db
        .delete(recallMetrics)
        .where(inArray(recallMetrics.id, aged))
        .returning({ id: recallMetrics.id });
      return deleted.length;
    },
  };
}
