import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FirestoreProfileMemoryMaintenance } from './profile-memory-maintenance.js';
import { disposeStore, emulatorStore } from './test-store.js';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

describe.skipIf(!enabled)('Firestore profile memory maintenance', () => {
  it('deduplicates graph sync tasks across active jobs and repeated minute events', async () => {
    const now = new Date('2026-09-19T22:14:37Z');
    const store = emulatorStore(() => now);
    const repository = new FirestoreProfileMemoryMaintenance(store);
    const agentId = randomUUID();
    const memoryId = randomUUID();
    try {
      await Promise.all([
        repository.queueGraphSync({ agentId, memoryId }),
        repository.queueGraphSync({ agentId, memoryId }),
      ]);
      const first = await store.collection('tasks').where('agentId', '==', agentId).get();
      expect(first.size).toBe(1);
      expect(first.docs[0]?.get('trigger.payload.job')).toBe('memory.graph_sync');
      await first.docs[0]?.ref.update({ status: 'done' });
      await repository.queueGraphSync({ agentId, memoryId });
      expect((await store.collection('tasks').where('agentId', '==', agentId).get()).size).toBe(1);
    } finally {
      await disposeStore(store);
    }
  });

  it('retries only an owned blocked graph source', async () => {
    const now = new Date('2026-09-19T22:14:37Z');
    const store = emulatorStore(() => now);
    const repository = new FirestoreProfileMemoryMaintenance(store);
    const agentId = randomUUID();
    const memoryId = randomUUID();
    try {
      await store.doc('memories', memoryId).set({ id: memoryId, agentId });
      await store.doc('knowledgeGraphSources', memoryId).set({
        memoryId,
        status: 'quarantined',
        attempts: 4,
        lastError: 'blocked',
      });
      await repository.retryBlockedGraphSource({ agentId: randomUUID(), memoryId });
      expect((await store.doc('knowledgeGraphSources', memoryId).get()).get('status')).toBe(
        'quarantined',
      );
      await repository.retryBlockedGraphSource({ agentId, memoryId });
      const source = await store.doc('knowledgeGraphSources', memoryId).get();
      expect(source.get('status')).toBe('failed');
      expect(source.get('attempts')).toBe(0);
      expect(source.get('lastError')).toBeNull();
      expect(source.get('nextRetryAt').toDate()).toEqual(now);
    } finally {
      await disposeStore(store);
    }
  });

  it('cascades a forgotten projection and removes aliases only for orphaned entities', async () => {
    const store = emulatorStore();
    const repository = new FirestoreProfileMemoryMaintenance(store);
    const agentId = randomUUID();
    const foreignAgentId = randomUUID();
    const memoryId = randomUUID();
    const retainedMemoryId = randomUUID();
    try {
      for (const [id, owner] of [
        ['orphan', agentId],
        ['shared', agentId],
        ['retained', agentId],
        ['foreign', foreignAgentId],
      ] as const)
        await store.doc('knowledgeGraphEntities', id).set({ id, agentId: owner });
      for (const [id, entityId, owner] of [
        ['orphan-alias', 'orphan', agentId],
        ['shared-alias', 'shared', agentId],
        ['dangling-alias', 'missing', agentId],
        ['foreign-alias', 'foreign', foreignAgentId],
      ] as const)
        await store.doc('knowledgeGraphEntityAliases', id).set({ id, entityId, agentId: owner });
      await store
        .doc('knowledgeGraphSources', memoryId)
        .set({ memoryId, agentId, status: 'ready' });
      await store.doc('knowledgeGraphRelations', 'forgotten').set({
        id: 'forgotten',
        agentId,
        sourceMemoryId: memoryId,
        subjectEntityId: 'orphan',
        objectEntityId: 'shared',
      });
      await store.doc('knowledgeGraphRelations', 'retained').set({
        id: 'retained',
        agentId,
        sourceMemoryId: retainedMemoryId,
        subjectEntityId: 'shared',
        objectEntityId: 'retained',
      });

      await repository.removeOrphanedGraphEntities({ agentId, memoryId });
      await repository.removeOrphanedGraphEntities({ agentId, memoryId });

      expect((await store.doc('knowledgeGraphSources', memoryId).get()).exists).toBe(false);
      expect((await store.doc('knowledgeGraphRelations', 'forgotten').get()).exists).toBe(false);
      expect((await store.doc('knowledgeGraphEntities', 'orphan').get()).exists).toBe(false);
      expect((await store.doc('knowledgeGraphEntityAliases', 'orphan-alias').get()).exists).toBe(
        false,
      );
      expect((await store.doc('knowledgeGraphEntityAliases', 'dangling-alias').get()).exists).toBe(
        false,
      );
      expect((await store.doc('knowledgeGraphEntities', 'shared').get()).exists).toBe(true);
      expect((await store.doc('knowledgeGraphEntityAliases', 'shared-alias').get()).exists).toBe(
        true,
      );
      expect((await store.doc('knowledgeGraphEntities', 'foreign').get()).exists).toBe(true);
      expect((await store.doc('knowledgeGraphEntityAliases', 'foreign-alias').get()).exists).toBe(
        true,
      );
    } finally {
      await disposeStore(store);
    }
  });

  it('refuses to cascade a source projection containing a foreign relation', async () => {
    const store = emulatorStore();
    const repository = new FirestoreProfileMemoryMaintenance(store);
    const memoryId = randomUUID();
    try {
      await store.doc('knowledgeGraphSources', memoryId).set({ memoryId, status: 'ready' });
      await store.doc('knowledgeGraphRelations', 'foreign').set({
        id: 'foreign',
        agentId: 'foreign-agent',
        sourceMemoryId: memoryId,
      });
      await expect(
        repository.removeOrphanedGraphEntities({ agentId: 'owner', memoryId }),
      ).rejects.toThrow('another agent');
      expect((await store.doc('knowledgeGraphSources', memoryId).get()).exists).toBe(true);
      expect((await store.doc('knowledgeGraphRelations', 'foreign').get()).exists).toBe(true);
    } finally {
      await disposeStore(store);
    }
  });

  it('refuses an unowned zero-relation source when its memory is already absent', async () => {
    const store = emulatorStore();
    const repository = new FirestoreProfileMemoryMaintenance(store);
    const memoryId = randomUUID();
    try {
      await store
        .doc('knowledgeGraphSources', memoryId)
        .set({ memoryId, agentId: 'foreign-agent', status: 'ready' });
      await expect(
        repository.removeOrphanedGraphEntities({ agentId: 'owner', memoryId }),
      ).rejects.toThrow('Cannot prove');
      expect((await store.doc('knowledgeGraphSources', memoryId).get()).exists).toBe(true);
    } finally {
      await disposeStore(store);
    }
  });
});
