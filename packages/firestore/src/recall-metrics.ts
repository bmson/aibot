import { randomUUID } from 'node:crypto';
import { historyLimit, type RecallMetricsRepository } from '@assistant/persistence';
import { encodeRecord, type InstallationStore } from './store.js';

export class FirestoreRecallMetricsRepository implements RecallMetricsRepository {
  readonly kind = 'recall-metrics-repository' as const;
  constructor(readonly store: InstallationStore) {}
  async record(input: Parameters<RecallMetricsRepository['record']>[0]): Promise<void> {
    const id = randomUUID();
    await this.store.db.runTransaction(async (tx) => {
      const agent = await tx.get(this.store.doc('agents', input.agentId));
      if (!agent.exists || agent.get('id') !== input.agentId)
        throw new Error('Unknown recall owner');
      for (const [collection, reference] of [
        ['tasks', input.taskId],
        ['conversations', input.conversationId],
      ] as const) {
        if (!reference) continue;
        const source = await tx.get(this.store.doc(collection, reference));
        if (
          !source.exists ||
          source.get('id') !== reference ||
          source.get('agentId') !== input.agentId
        )
          throw new Error('Recall telemetry references a foreign or missing source');
      }
      tx.create(
        this.store.doc('recallMetrics', id),
        encodeRecord({
          ...input,
          id,
          createdAt: this.store.now(),
          taskId: input.taskId ?? null,
          conversationId: input.conversationId ?? null,
        }),
      );
    });
  }
  async purge({
    notAfter,
    limit,
  }: Parameters<RecallMetricsRepository['purge']>[0]): Promise<number> {
    historyLimit(limit, 500);
    return this.store.db.runTransaction(async (tx) => {
      const rows = await tx.get(
        this.store.collection('recallMetrics').where('createdAt', '<=', notAfter).limit(limit),
      );
      for (const row of rows.docs) tx.delete(row.ref);
      return rows.size;
    });
  }
}
