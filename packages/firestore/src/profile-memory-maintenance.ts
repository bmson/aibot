import {
  graphSyncTaskInput,
  type ProfileMemoryMaintenance,
  type Records,
} from '@assistant/persistence';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';
import { createTask } from './task-creation.js';

const RELATION_DELETE_PAGE = 100;
const ENTITY_ALIAS_BOUND = 400;

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
    const candidateEntityIds = new Set<string>();
    let ownershipProven = false;
    for (;;) {
      const page = await this.store.db.runTransaction(async (tx) => {
        const [memory, source, relations] = await Promise.all([
          tx.get(this.store.doc('memories', input.memoryId)),
          tx.get(this.store.doc('knowledgeGraphSources', input.memoryId)),
          tx.get(
            this.store
              .collection('knowledgeGraphRelations')
              .where('sourceMemoryId', '==', input.memoryId)
              .limit(RELATION_DELETE_PAGE),
          ),
        ]);
        if (memory.exists && memory.get('agentId') !== input.agentId)
          throw new Error('Graph source belongs to another agent');
        let pageOwnershipProven = source.exists && source.get('agentId') === input.agentId;
        const ids: string[] = [];
        for (const relation of relations.docs) {
          if (relation.get('agentId') !== input.agentId)
            throw new Error('Graph source belongs to another agent');
          pageOwnershipProven = true;
          for (const field of ['subjectEntityId', 'objectEntityId']) {
            const id = relation.get(field);
            if (typeof id !== 'string' || !id) throw new Error('Invalid graph relation endpoint');
            ids.push(id);
          }
          tx.delete(relation.ref);
        }
        return { ids, ownershipProven: pageOwnershipProven };
      });
      ownershipProven ||= page.ownershipProven;
      for (const id of page.ids) candidateEntityIds.add(id);
      if (page.ids.length > 0) continue;

      const sourceRemoved = await this.store.db.runTransaction(async (tx) => {
        const [source, relation] = await Promise.all([
          tx.get(this.store.doc('knowledgeGraphSources', input.memoryId)),
          tx.get(
            this.store
              .collection('knowledgeGraphRelations')
              .where('sourceMemoryId', '==', input.memoryId)
              .limit(1),
          ),
        ]);
        if (!relation.empty) return false;
        if (!source.exists) return true;
        if (!ownershipProven && source.get('agentId') !== input.agentId)
          throw new Error('Cannot prove graph source ownership');
        tx.delete(source.ref);
        return true;
      });
      if (sourceRemoved) break;
    }

    for (const entityId of candidateEntityIds) {
      await this.store.db.runTransaction(async (tx) => {
        const entityRef = this.store.doc('knowledgeGraphEntities', entityId);
        const [entity, subjects, objects, aliases] = await Promise.all([
          tx.get(entityRef),
          tx.get(
            this.store
              .collection('knowledgeGraphRelations')
              .where('subjectEntityId', '==', entityId)
              .limit(1),
          ),
          tx.get(
            this.store
              .collection('knowledgeGraphRelations')
              .where('objectEntityId', '==', entityId)
              .limit(1),
          ),
          tx.get(
            this.store
              .collection('knowledgeGraphEntityAliases')
              .where('entityId', '==', entityId)
              .limit(ENTITY_ALIAS_BOUND + 1),
          ),
        ]);
        if (!entity.exists || !subjects.empty || !objects.empty) return;
        if (entity.get('agentId') !== input.agentId)
          throw new Error('Graph entity belongs to another agent');
        if (aliases.size > ENTITY_ALIAS_BOUND) throw new Error('Graph entity alias bound reached');
        if (aliases.docs.some((alias) => alias.get('agentId') !== input.agentId))
          throw new Error('Graph entity alias belongs to another agent');
        for (const alias of aliases.docs) tx.delete(alias.ref);
        tx.delete(entityRef);
      });
    }
  }
}
