import { randomUUID } from 'node:crypto';
import {
  FirestoreApprovalPolicyRepository,
  FirestoreApprovalRepository,
  FirestoreCostRepository,
  FirestoreGoalProgressRepository,
  FirestoreToolExecutionRepository,
} from '@assistant/firestore';
import { describe, expect, it } from 'vitest';
import { disposeStore, emulatorStore } from '../../../firestore/src/test-store.js';
import { ToolDispatcher } from '../dispatcher.js';
import { ToolRegistry } from '../registry.js';
import type { ToolContext } from '../types.js';
import { registerPortableGoalProgressTool } from './goal-progress.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore goal progress tool', () => {
  it('records verified work for the bound goal without PostgreSQL or schedule changes', async () => {
    const store = emulatorStore();
    try {
      const agentId = 'owner';
      const goalId = randomUUID();
      const otherGoalId = randomUUID();
      const taskId = randomUUID();
      const now = new Date('2026-09-23T12:00:00.000Z');
      await store.doc('agents', agentId).set({ id: agentId });
      for (const id of [goalId, otherGoalId]) {
        await store.doc('goals', id).set({
          id,
          agentId,
          title: id === goalId ? 'My goal' : 'Other goal',
          progress: 'Before',
          nextAction: 'Wait',
          updatedAt: now,
        });
      }
      await store.doc('schedules', 'schedule').set({
        id: 'schedule',
        agentId,
        name: `goal:${goalId}`,
        enabled: true,
        nextRunAt: now,
      });
      await store.doc('tasks', taskId).set({
        id: taskId,
        agentId,
        type: 'scheduled',
        trust: 'assistant',
        status: 'running',
        goalId,
      });
      const db = new Proxy({} as ToolContext['db'], {
        get() {
          throw new Error('PostgreSQL access is unavailable');
        },
      });
      const registry = registerPortableGoalProgressTool(
        new ToolRegistry(),
        new FirestoreGoalProgressRepository(store, agentId),
      );
      const dispatcher = new ToolDispatcher(
        db,
        registry,
        new FirestoreToolExecutionRepository(store),
        new FirestoreCostRepository(store),
        new FirestoreApprovalRepository(store),
        new FirestoreApprovalPolicyRepository(store),
      );
      const task = {
        id: taskId,
        agentId,
        type: 'scheduled',
        trust: 'assistant',
        status: 'running',
        goalId,
        conversationId: null,
        createdAt: now,
        trigger: null,
      } as never;
      const ctx = {
        taskId,
        agentId,
        trust: 'assistant',
        tainted: true,
        db,
        now: () => now,
        signal: new AbortController().signal,
        log: async () => {},
      } as ToolContext;
      const dispatch = (step: number, target: string) =>
        dispatcher.dispatch({
          task,
          step,
          toolName: 'goals.update_progress',
          args: { goalId: target, progress: 'Verified one step', nextAction: 'Continue' },
          ctx,
          provenance: { plannerVersion: 1, promptVersion: 1, model: 'test' },
        });

      expect(await dispatch(1, goalId)).toMatchObject({ kind: 'rejected' });
      await store.doc('toolCalls', 'evidence').set({
        id: 'evidence',
        taskId,
        toolName: 'web.fetch',
        status: 'succeeded',
        result: { status: 200 },
      });
      expect(await dispatch(2, otherGoalId)).toMatchObject({ kind: 'rejected' });
      expect(await dispatch(3, goalId)).toMatchObject({
        kind: 'executed',
        result: { updated: goalId, title: 'My goal' },
      });
      expect((await store.doc('goals', goalId).get()).data()).toMatchObject({
        progress: 'Verified one step',
        nextAction: 'Continue',
      });
      expect((await store.doc('goals', otherGoalId).get()).get('progress')).toBe('Before');
      const schedule = await store.doc('schedules', 'schedule').get();
      expect(schedule.get('enabled')).toBe(true);
      expect(schedule.get('nextRunAt').toDate()).toEqual(now);
      const progressTool = registry.get('goals.update_progress');
      if (!progressTool) throw new Error('goal progress tool was not registered');
      await expect(
        progressTool.tool.execute({ goalId, progress: 'Untrusted edit', nextAction: '' } as never, {
          ...ctx,
          trust: 'unknown',
        }),
      ).rejects.toThrow('owner/assistant');
      expect((await store.doc('goals', goalId).get()).get('progress')).toBe('Verified one step');

      // Owner work chats can carry their binding in conversation metadata.
      const chatTaskId = randomUUID();
      const conversationId = randomUUID();
      await store.doc('conversations', conversationId).set({
        id: conversationId,
        agentId,
        metadata: { goalId },
      });
      await store.doc('tasks', chatTaskId).set({
        id: chatTaskId,
        agentId,
        type: 'chat_turn',
        trust: 'owner',
        status: 'running',
        conversationId,
      });
      expect(
        await dispatcher.dispatch({
          task: {
            id: chatTaskId,
            agentId,
            type: 'chat_turn',
            trust: 'owner',
            status: 'running',
            goalId: null,
            conversationId,
            createdAt: now,
            trigger: null,
          } as never,
          step: 1,
          toolName: 'goals.update_progress',
          args: { goalId, progress: 'Owner reviewed', nextAction: '' },
          ctx: { ...ctx, taskId: chatTaskId, trust: 'owner', tainted: false },
          provenance: { plannerVersion: 1, promptVersion: 1, model: 'test' },
        }),
      ).toMatchObject({ kind: 'executed' });
      expect((await store.doc('goals', goalId).get()).get('progress')).toBe('Owner reviewed');
    } finally {
      await disposeStore(store);
    }
  });

  it('fails closed for a foreign owner and active privacy erasure', async () => {
    const store = emulatorStore();
    try {
      const goalId = randomUUID();
      await store.doc('agents', 'owner').set({ id: 'owner' });
      await store.doc('goals', goalId).set({
        id: goalId,
        agentId: 'owner',
        title: 'Private',
        progress: 'Before',
      });
      const repository = new FirestoreGoalProgressRepository(store, 'owner');
      const input = { agentId: 'owner', goalId, progress: 'After', nextAction: '' };
      await expect(repository.updateProgress({ ...input, agentId: 'stranger' })).rejects.toThrow();
      await store.doc('privacyErasureJobs', 'owner').set({
        agentId: 'owner',
        status: 'active',
      });
      await expect(repository.updateProgress(input)).rejects.toThrow('Privacy erasure');
      expect((await store.doc('goals', goalId).get()).get('progress')).toBe('Before');
    } finally {
      await disposeStore(store);
    }
  });
});
