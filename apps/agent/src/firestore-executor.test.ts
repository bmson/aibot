import { type ExecutorDeps, executeTask, TaskStateSchema } from '@assistant/core';
import type { Db } from '@assistant/db';
import { createFirestoreExecutionPersistence } from '@assistant/firestore';
import { taskFixture } from '@assistant/persistence/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstallationStore } from '../../../packages/firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';
import { firestoreExecutorSmoke } from '../../../scripts/firestore-executor-smoke.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore executor recovery composition',
  () => {
    let store: InstallationStore;
    let deps: ExecutorDeps;
    beforeEach(async () => {
      store = emulatorStore();
      // Any unmigrated SQL/model/tool path is an immediate failure in this recovery test.
      const unavailable = new Proxy(
        {},
        {
          get: (_target, property) => {
            throw new Error(`Unexpected dependency access: ${String(property)}`);
          },
        },
      );
      deps = {
        db: unavailable as Db,
        router: unavailable as ExecutorDeps['router'],
        dispatcher: unavailable as ExecutorDeps['dispatcher'],
        persistence: createFirestoreExecutionPersistence(store, 'agent', {
          provider: 'synthetic',
          model: 'recovery-fixture',
          dimensions: 1536,
          revision: '1',
        }),
      };
      await store
        .doc('conversations', 'chat')
        .set({ id: 'chat', agentId: 'agent', channel: 'chat' });
    });
    afterEach(async () => {
      await disposeStore(store);
    });

    async function pendingFinalTask() {
      const task = taskFixture({
        id: 'task',
        agentId: 'agent',
        conversationId: 'chat',
        reminderId: '',
      });
      task.trigger = {};
      task.state = TaskStateSchema.parse({
        pendingFinal: {
          text: 'Verified response',
          progress: 'Completed',
          terminalStatus: 'done',
          outcome: 'done',
        },
      });
      await store.doc('tasks', task.id).set(task);
      return task;
    }

    it('exercises the same scoped queries and recovery workload as live validation', async () => {
      expect(await firestoreExecutorSmoke(store)).toMatchObject({ finalized: true, delivered: 1 });
    });

    it('resumes a durable final response and completes without PostgreSQL or another model call', async () => {
      const task = await pendingFinalTask();
      const deliver = vi.fn(async () => {});
      deps.deliverFinal = deliver;
      expect(await executeTask(deps, task.id)).toEqual({ outcome: 'done', detail: 'Completed' });
      expect(deliver).toHaveBeenCalledOnce();
      expect((await store.doc('tasks', task.id).get()).get('status')).toBe('done');
      expect((await store.collection('messages').get()).size).toBe(1);
      expect((await store.collection('responseChecks').get()).size).toBe(1);
      expect(await executeTask(deps, task.id)).toEqual({ outcome: 'not_claimable' });
      expect(deliver).toHaveBeenCalledOnce();
    });

    it('reuses the persisted message after a definitive delivery rejection', async () => {
      const task = await pendingFinalTask();
      deps.deliverFinal = vi
        .fn()
        .mockRejectedValueOnce(new Error('definitive rejection'))
        .mockResolvedValue(undefined);
      expect((await executeTask(deps, task.id)).outcome).toBe('failed');
      expect((await store.collection('messages').get()).size).toBe(1);
      await store.doc('tasks', task.id).update({ runAfter: new Date(0) });
      expect((await executeTask(deps, task.id)).outcome).toBe('done');
      expect(deps.deliverFinal).toHaveBeenCalledTimes(2);
      expect((await store.collection('messages').get()).size).toBe(1);
      expect((await store.collection('responseChecks').get()).size).toBe(1);
    });

    it('refuses to append a final response into another agent conversation', async () => {
      const task = await pendingFinalTask();
      await store
        .doc('conversations', 'foreign-chat')
        .set({ id: 'foreign-chat', agentId: 'other', channel: 'chat' });
      await store.doc('tasks', task.id).update({ conversationId: 'foreign-chat' });

      expect((await executeTask(deps, task.id)).outcome).toBe('failed');
      expect((await store.collection('messages').get()).empty).toBe(true);
      expect((await store.doc('tasks', task.id).get()).get('status')).toBe('sleeping');
    });

    it('parks approved work on its budget while preserving the pending action', async () => {
      const task = await pendingFinalTask();
      await store.doc('agents', 'agent').set({ id: 'agent', name: 'Synthetic owner' });
      await store.doc('tasks', task.id).update({
        state: TaskStateSchema.parse({
          step: 1,
          contextWindow: [{ role: 'user', content: 'Continue' }],
          pendingApprovals: [
            {
              approvalId: 'approval',
              dbToolCallId: 'call',
              toolCallId: 'model-call',
              toolName: 'synthetic.action',
            },
          ],
        }),
      });
      await store
        .doc('approvals', 'approval')
        .set({ id: 'approval', taskId: task.id, toolCallId: 'call', status: 'approved' });
      const executeApproved = vi.fn(async () => ({
        kind: 'budget_blocked' as const,
        reason: 'daily cap',
        resumeAt: new Date(Date.now() + 60_000),
      }));
      deps.dispatcher = { executeApproved } as unknown as ExecutorDeps['dispatcher'];
      expect((await executeTask(deps, task.id)).outcome).toBe('parked');
      expect(executeApproved).toHaveBeenCalledOnce();
      const row = await store.doc('tasks', task.id).get();
      expect(row.get('status')).toBe('waiting_budget');
      expect(row.get('state').pendingApprovals).toHaveLength(1);
      expect((await store.collection('messages').get()).size).toBe(1);
    });

    it('never executes an approval referenced from a different task', async () => {
      const task = await pendingFinalTask();
      await store.doc('agents', 'agent').set({ id: 'agent', name: 'Synthetic owner' });
      await store.doc('tasks', task.id).update({
        state: TaskStateSchema.parse({
          step: 1,
          contextWindow: [{ role: 'user', content: 'Continue' }],
          pendingApprovals: [
            {
              approvalId: 'foreign-approval',
              dbToolCallId: 'call',
              toolCallId: 'model-call',
              toolName: 'synthetic.action',
            },
          ],
        }),
      });
      await store.doc('approvals', 'foreign-approval').set({
        id: 'foreign-approval',
        taskId: 'other-task',
        toolCallId: 'call',
        status: 'approved',
      });
      const executeApproved = vi.fn();
      deps.dispatcher = { executeApproved } as unknown as ExecutorDeps['dispatcher'];
      expect((await executeTask(deps, task.id)).outcome).toBe('parked');
      expect(executeApproved).not.toHaveBeenCalled();
      expect((await store.doc('tasks', task.id).get()).get('status')).toBe('waiting_approval');
    });

    it('cancels queued work for an abandoned goal before loading model or tool dependencies', async () => {
      const task = await pendingFinalTask();
      await store
        .doc('goals', 'goal')
        .set({ id: 'goal', agentId: 'agent', status: 'abandoned', archivedAt: null });
      await store.doc('tasks', task.id).update({ goalId: 'goal' });
      expect(await executeTask(deps, task.id)).toEqual({
        outcome: 'cancelled',
        detail: 'goal stopped',
      });
      expect((await store.doc('tasks', task.id).get()).get('status')).toBe('cancelled');
      expect((await store.collection('messages').get()).empty).toBe(true);
    });
  },
);
