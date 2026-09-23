import { randomUUID } from 'node:crypto';
import { taskFixture } from '@assistant/persistence/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InstallationStore } from './store.js';
import { FirestoreTaskActivityCommandRepository } from './task-activity-commands.js';
import { FirestoreTaskRepository } from './task-lifecycle.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore Activity retry and cancel commands',
  () => {
    let store: InstallationStore;
    let repository: FirestoreTaskActivityCommandRepository;
    const agentId = randomUUID();
    const foreignAgentId = randomUUID();
    const retryId = randomUUID();
    const runningId = randomUUID();

    beforeEach(async () => {
      store = emulatorStore();
      repository = new FirestoreTaskActivityCommandRepository(store);
      await store.doc('agents', agentId).set({ id: agentId });
      await store.doc('tasks', retryId).set({
        ...taskFixture({
          id: retryId,
          agentId,
          conversationId: randomUUID(),
          reminderId: '',
        }),
        status: 'needs_attention',
        queueGeneration: 5,
        attempt: 3,
        state: { checkpoint: 'resume', pendingFinal: { text: 'already delivered' } },
      });
      await store.doc('tasks', runningId).set({
        ...taskFixture({
          id: runningId,
          agentId,
          conversationId: randomUUID(),
          reminderId: '',
        }),
        status: 'running',
        lockedUntil: new Date(Date.now() + 60_000),
        leaseToken: randomUUID(),
      });
      await store.doc('tasks', 'foreign').set({
        ...taskFixture({
          id: 'foreign',
          agentId: foreignAgentId,
          conversationId: randomUUID(),
          reminderId: '',
        }),
        status: 'needs_attention',
      });
    });

    afterEach(async () => {
      await disposeStore(store);
    });

    it('retries once and commits exactly one matching wake intent', async () => {
      await Promise.all([repository.retry(agentId, retryId), repository.retry(agentId, retryId)]);
      const task = await store.doc('tasks', retryId).get();
      expect(task.get('status')).toBe('pending');
      expect(task.get('queueGeneration')).toBe(6);
      expect(task.get('attempt')).toBe(0);
      expect(task.get('state')).toEqual({ checkpoint: 'resume' });
      const intents = await store.collection('outbox').get();
      expect(intents.size).toBe(1);
      expect(intents.docs[0]?.get('taskId')).toBe(retryId);
      expect(intents.docs[0]?.get('generation')).toBe(6);
    });

    it('rejects foreign work and fences retry during privacy erasure', async () => {
      await expect(repository.retry(agentId, 'foreign')).rejects.toThrow('activity item not found');
      await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
      await expect(repository.retry(agentId, retryId)).rejects.toThrow(
        'Privacy erasure is in progress',
      );
      expect((await store.doc('tasks', retryId).get()).get('status')).toBe('needs_attention');
      expect((await store.collection('outbox').get()).size).toBe(0);
    });

    it('cancels a running task idempotently and prevents its lease from being claimed', async () => {
      await repository.cancel(agentId, runningId);
      await repository.cancel(agentId, runningId);
      const task = await store.doc('tasks', runningId).get();
      expect(task.get('status')).toBe('cancelled');
      expect(task.get('leaseToken')).toBeNull();
      expect(task.get('lockedUntil')).toBeNull();
      expect(await new FirestoreTaskRepository(store).claim(runningId)).toBeNull();
    });

    it('leaves the task unchanged when cancellation races with privacy erasure', async () => {
      await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
      await expect(repository.cancel(agentId, runningId)).rejects.toThrow(
        'Privacy erasure is in progress',
      );
      expect((await store.doc('tasks', runningId).get()).get('status')).toBe('running');
    });
  },
);
