import { taskFixture } from '@assistant/persistence/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstallationStore } from './store.js';
import { FirestoreTaskRepository } from './task-lifecycle.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore task lifecycle coordination',
  () => {
    let store: InstallationStore, repo: FirestoreTaskRepository;
    beforeEach(async () => {
      store = emulatorStore();
      repo = new FirestoreTaskRepository(store);
      await store.doc('schedules', 'reminder').set({ id: 'reminder', enabled: true });
      await store.doc('tasks', 'task').set(
        taskFixture({
          id: 'task',
          agentId: 'agent',
          conversationId: 'conversation',
          reminderId: 'reminder',
        }),
      );
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await disposeStore(store);
    });
    it('commits sleep/wake generations with durable queue intents and excludes future tasks', async () => {
      const lease = await repo.claim('task');
      if (!lease) throw new Error('Missing test lease');
      expect(await repo.sleepTask(lease, { phase: 'paused' }, new Date(Date.now() + 60_000))).toBe(
        true,
      );
      expect((await store.collection('outbox').get()).size).toBe(1);
      expect(await repo.findDueTasks()).toEqual([]);
      expect(await repo.wakeTask('task')).toMatchObject({ queueGeneration: 2 });
      expect((await store.collection('outbox').get()).size).toBe(2);
      expect((await repo.findDueTasks()).map((t) => t.id)).toEqual(['task']);
    });
    it('rechecks a lease renewed after the recovery query before mutating it', async () => {
      await store.doc('tasks', 'task').update({ status: 'running', lockedUntil: new Date(0) });
      const runTransaction = store.db.runTransaction.bind(store.db);
      vi.spyOn(store.db, 'runTransaction').mockImplementationOnce(async (callback, options) => {
        await store.doc('tasks', 'task').update({ lockedUntil: new Date(Date.now() + 600_000) });
        return runTransaction(callback, options);
      });
      await repo.findDueTasks();
      expect((await store.doc('tasks', 'task').get()).get('status')).toBe('running');
      expect((await store.doc('tasks', 'task').get()).get('reclaimCount')).toBe(0);
    });
    it('dead-letters repeatedly abandoned work without publishing another queue intent', async () => {
      await store
        .doc('tasks', 'task')
        .update({ status: 'running', lockedUntil: new Date(0), reclaimCount: 7 });
      expect(await repo.findDueTasks()).toEqual([]);
      expect((await store.doc('tasks', 'task').get()).get('status')).toBe('needs_attention');
      expect((await store.collection('outbox').get()).size).toBe(0);
    });
    it('persists plans only for the current owner lease', async () => {
      const first = await repo.claim('task');
      if (!first) throw new Error('Missing initial lease');

      // Reclaim the task so the first worker's token is stale.
      await store.doc('tasks', 'task').update({ lockedUntil: new Date(0) });
      const replacement = await repo.claim('task');
      if (!replacement) throw new Error('Missing replacement lease');

      expect(await repo.persistPlan(first, { stale: true })).toBe(false);
      expect(
        await repo.persistPlan({ ...replacement, agentId: 'foreign-agent' }, { foreign: true }),
      ).toBe(false);
      expect(await repo.persistPlan(replacement, { steps: ['current'] })).toBe(true);
      expect((await store.doc('tasks', 'task').get()).get('plan')).toEqual({
        steps: ['current'],
      });
    });
  },
);
