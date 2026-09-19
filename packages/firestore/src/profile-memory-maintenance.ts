import {
  graphSyncTaskInput,
  type ProfileMemoryMaintenance,
  type Records,
} from '@assistant/persistence';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';
import { createTask } from './task-creation.js';

const CLEANUP_BOUND = 150;

export class FirestoreProfileMemoryMaintenance implements ProfileMemoryMaintenance {
  readonly kind = 'profile-memory-maintenance' as const;

  constructor(readonly store: InstallationStore) {}

  async queueGraphSync(input: { agentId: string; memoryId: string }): Promise<void> {
    const active = await this.store
      .collection('tasks')
      .where('agentId', '==', input.agentId)
      .where('status', 'in', ['pending', 'running'])
      .where('trigger.payload.job', '==', 'memory.graph_sync')
      .limit(1)
      .get();
    if (!active.empty) return;
    await createTask(
      this.store,
      graphSyncTaskInput(input.agentId, input.memoryId, this.store.now()),
    );
  }

  async retryBlockedGraphSource(input: { agentId: string; memoryId: string }): Promise<void> {
    const memoryRef = this.store.doc('memories', input.memoryId);
    const sourceRef = this.store.doc('knowledgeGraphSources', input.memoryId);
    await this.store.db.runTransaction(async (tx) => {
      const [memoryDoc, sourceDoc] = await tx.getAll(memoryRef, sourceRef);
      if (!memoryDoc?.exists || !sourceDoc?.exists) return;
      const memory = decodeRecord<Records['memories']>(memoryDoc.data());
      const source = decodeRecord<Records['knowledgeGraphSources']>(sourceDoc.data());
      if (
        documentKey(memory.id) !== memoryDoc.id ||
        memory.agentId !== input.agentId ||
        source.memoryId !== input.memoryId ||
        !['failed', 'quarantined'].includes(source.status)
      )
        return;
      const now = this.store.now();
      tx.update(sourceRef, {
        attempts: 0,
        lastError: null,
        nextRetryAt: now,
        status: 'failed',
        updatedAt: now,
      });
    });
  }

  async removeOrphanedGraphEntities(input: { agentId: string; memoryId: string }): Promise<void> {
    await this.store.db.runTransaction(async (tx) => {
      const [memory, source, sourceRelations, agentRelations, entities, aliases] =
        await Promise.all([
          tx.get(this.store.doc('memories', input.memoryId)),
          tx.get(this.store.doc('knowledgeGraphSources', input.memoryId)),
          tx.get(
            this.store
              .collection('knowledgeGraphRelations')
              .where('sourceMemoryId', '==', input.memoryId)
              .limit(CLEANUP_BOUND + 1),
          ),
          tx.get(
            this.store
              .collection('knowledgeGraphRelations')
              .where('agentId', '==', input.agentId)
              .limit(CLEANUP_BOUND + 1),
          ),
          tx.get(
            this.store
              .collection('knowledgeGraphEntities')
              .where('agentId', '==', input.agentId)
              .limit(CLEANUP_BOUND + 1),
          ),
          tx.get(
            this.store
              .collection('knowledgeGraphEntityAliases')
              .where('agentId', '==', input.agentId)
              .limit(CLEANUP_BOUND + 1),
          ),
        ]);
      if (memory.exists && memory.get('agentId') !== input.agentId)
        throw new Error('Graph source belongs to another agent');
      if (
        [sourceRelations, agentRelations, entities, aliases].some(
          (rows) => rows.size > CLEANUP_BOUND,
        )
      )
        throw new Error('Graph cleanup bound reached');
      if (sourceRelations.docs.some((doc) => doc.get('agentId') !== input.agentId))
        throw new Error('Graph source belongs to another agent');
      const sourceOwned =
        !source.exists ||
        source.get('agentId') === input.agentId ||
        sourceRelations.docs.length > 0;
      if (!sourceOwned) throw new Error('Cannot prove graph source ownership');

      const removedRelationIds = new Set(sourceRelations.docs.map((doc) => doc.id));
      const referenced = new Set<string>();
      for (const doc of agentRelations.docs) {
        if (removedRelationIds.has(doc.id)) continue;
        for (const field of ['subjectEntityId', 'objectEntityId']) {
          const id = doc.get(field);
          if (typeof id === 'string') referenced.add(id);
        }
      }
      const entityIds = new Set(entities.docs.map((doc) => String(doc.get('id'))));
      const orphanIds = new Set(
        entities.docs.map((doc) => String(doc.get('id'))).filter((id) => !referenced.has(id)),
      );
      if (source.exists) tx.delete(source.ref);
      for (const doc of sourceRelations.docs) tx.delete(doc.ref);
      for (const doc of entities.docs) if (orphanIds.has(String(doc.get('id')))) tx.delete(doc.ref);
      for (const doc of aliases.docs) {
        const entityId = String(doc.get('entityId'));
        if (!entityIds.has(entityId) || orphanIds.has(entityId)) tx.delete(doc.ref);
      }
    });
  }
}
