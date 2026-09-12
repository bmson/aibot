import {
  FirestoreApprovalPolicyRepository,
  FirestoreApprovalRepository,
  FirestoreCostRepository,
  FirestoreToolExecutionRepository,
} from '@assistant/firestore';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { disposeStore, emulatorStore, seedBudget } from '../../firestore/src/test-store.js';
import { ToolDispatcher } from './dispatcher.js';
import { ToolRegistry } from './registry.js';
import type { ToolContext } from './types.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'ToolDispatcher Firestore composition',
  () => {
    it('executes an idempotent autonomous call once under concurrent retries and reuses cache', async () => {
      const store = emulatorStore();
      try {
        const execution = new FirestoreToolExecutionRepository(store);
        const costs = new FirestoreCostRepository(store);
        const approvals = new FirestoreApprovalRepository(store);
        const policies = new FirestoreApprovalPolicyRepository(store);
        const calls = { count: 0 };
        const registry = new ToolRegistry()
          .register({
            name: 'test.firestore',
            description: 'test',
            inputSchema: z.object({ value: z.string() }),
            risk: 'autonomous',
            acceptsUntrustedInput: true,
            idempotencyKey: () => 'same-call',
            execute: async () => {
              calls.count += 1;
              return { ok: true };
            },
          })
          .register({
            name: 'test.firestore.cache',
            description: 'cache test',
            inputSchema: z.object({ value: z.string() }),
            risk: 'autonomous',
            acceptsUntrustedInput: true,
            cacheTtlSeconds: 60,
            execute: async () => {
              calls.count += 1;
              return { cached: true };
            },
          });
        const dispatcher = new ToolDispatcher(
          {} as never,
          registry,
          execution,
          costs,
          approvals,
          policies,
        );
        const task = {
          id: 'task',
          agentId: 'agent',
          type: 'adhoc',
          trust: 'owner',
          status: 'running',
          createdAt: new Date(),
          trigger: null,
          conversationId: null,
          goalId: null,
        } as never;
        await store
          .doc('tasks', 'task')
          .set({ id: 'task', agentId: 'agent', type: 'adhoc', status: 'running' });
        const ctx = {
          taskId: 'task',
          agentId: 'agent',
          trust: 'owner',
          tainted: false,
          db: {} as never,
          now: () => new Date(),
          signal: new AbortController().signal,
          log: async () => {},
        } as ToolContext;
        const results = await Promise.all([
          dispatcher.dispatch({
            task,
            step: 1,
            toolName: 'test.firestore',
            args: { value: 'x' },
            ctx,
            provenance: { plannerVersion: 1, promptVersion: 1, model: 'test' },
          }),
          dispatcher.dispatch({
            task,
            step: 1,
            toolName: 'test.firestore',
            args: { value: 'x' },
            ctx,
            provenance: { plannerVersion: 1, promptVersion: 1, model: 'test' },
          }),
        ]);
        expect(calls.count).toBe(1);
        expect(results.filter((result) => result.kind === 'executed')).toHaveLength(1);
        expect(
          (
            await dispatcher.dispatch({
              task,
              step: 2,
              toolName: 'test.firestore',
              args: { value: 'x' },
              ctx,
              provenance: { plannerVersion: 1, promptVersion: 1, model: 'test' },
            })
          ).kind,
        ).toBe('executed');
        expect(calls.count).toBe(1);
        const cachedTask = Object.assign({}, task, { id: 'cache-task' }) as never;
        await store
          .doc('tasks', 'cache-task')
          .set({ id: 'cache-task', agentId: 'agent', type: 'adhoc', status: 'running' });
        const firstCache = await dispatcher.dispatch({
          task: cachedTask,
          step: 1,
          toolName: 'test.firestore.cache',
          args: { value: 'x' },
          ctx: { ...ctx, taskId: 'cache-task' },
          provenance: { plannerVersion: 1, promptVersion: 1, model: 'test' },
        });
        const secondCache = await dispatcher.dispatch({
          task: cachedTask,
          step: 2,
          toolName: 'test.firestore.cache',
          args: { value: 'x' },
          ctx: { ...ctx, taskId: 'cache-task' },
          provenance: { plannerVersion: 1, promptVersion: 1, model: 'test' },
        });
        expect(firstCache.kind).toBe('executed');
        expect(secondCache.kind).toBe('executed');
        expect(calls.count).toBe(2);
        await store.doc('rateLimits', 'tool:test.firestore.cache').set({
          scope: 'tool:test.firestore.cache',
          maxPerHour: 1,
          maxPerDay: null,
        });
        const capped = await dispatcher.dispatch({
          task: cachedTask,
          step: 3,
          toolName: 'test.firestore.cache',
          args: { value: 'different' },
          ctx: { ...ctx, taskId: 'cache-task' },
          provenance: { plannerVersion: 1, promptVersion: 1, model: 'test' },
        });
        expect(capped).toMatchObject({
          kind: 'rejected',
          reason: expect.stringContaining('rate limit'),
        });
      } finally {
        await disposeStore(store);
      }
    });

    it('suppresses retries when terminal persistence reports a conflict after paid execution', async () => {
      const store = emulatorStore();
      try {
        await seedBudget(store);
        await store.doc('rateTable', 'external_api').set({ unit: 'call', unitPriceUsd: 0.1 });
        await store.doc('tasks', 'paid-task').set({
          id: 'paid-task',
          agentId: 'agent',
          type: 'adhoc',
          status: 'running',
          spentUsd: '0',
          budgetUsdLimit: '1',
        });
        const execution = new FirestoreToolExecutionRepository(store);
        const costs = new FirestoreCostRepository(store);
        const paidExecute = vi.fn(async () => ({ ok: true }));
        const dispatcher = new ToolDispatcher(
          {} as never,
          new ToolRegistry().register({
            name: 'test.paid',
            description: 'paid',
            inputSchema: z.object({ value: z.string() }),
            risk: 'autonomous',
            acceptsUntrustedInput: true,
            idempotencyKey: () => 'paid-once',
            estimateCost: () => ({ source: 'external_api', rateKey: 'external_api', quantity: 1 }),
            execute: paidExecute,
          }),
          execution,
          costs,
          new FirestoreApprovalRepository(store),
          new FirestoreApprovalPolicyRepository(store),
        );
        vi.spyOn(execution, 'outcome').mockResolvedValue(false);
        const task = {
          id: 'paid-task',
          agentId: 'agent',
          type: 'adhoc',
          trust: 'owner',
          status: 'running',
          createdAt: new Date(),
          trigger: null,
          conversationId: null,
          goalId: null,
        } as never;
        const ctx = {
          taskId: 'paid-task',
          agentId: 'agent',
          trust: 'owner',
          tainted: false,
          db: {} as never,
          now: () => new Date(),
          signal: new AbortController().signal,
          log: async () => {},
        } as ToolContext;
        const first = await dispatcher.dispatch({
          task,
          step: 1,
          toolName: 'test.paid',
          args: { value: 'x' },
          ctx,
          provenance: { plannerVersion: 1, promptVersion: 1, model: 'test' },
        });
        const second = await dispatcher.dispatch({
          task,
          step: 2,
          toolName: 'test.paid',
          args: { value: 'x' },
          ctx,
          provenance: { plannerVersion: 1, promptVersion: 1, model: 'test' },
        });
        expect(first.kind).toBe('rejected');
        expect(second.kind).toBe('rejected');
        expect(paidExecute).toHaveBeenCalledTimes(1);
        const persistedCalls = await store.collection('toolCalls').limit(1).get();
        expect(persistedCalls.size).toBe(1);
        expect(persistedCalls.docs[0]?.get('status')).toBe('executing');
        expect((await costs.totals()).heldUsd).toBe(0);
        expect((await costs.totals()).dailySpentUsd).toBeGreaterThan(0);
        const throwingExecution = new FirestoreToolExecutionRepository(store);
        const throwingExecute = vi.fn(async () => ({ ok: true }));
        const throwingDispatcher = new ToolDispatcher(
          {} as never,
          new ToolRegistry().register({
            name: 'test.throwing',
            description: 'throwing persistence',
            inputSchema: z.object({ value: z.string() }),
            risk: 'autonomous',
            acceptsUntrustedInput: true,
            idempotencyKey: () => 'throw-once',
            estimateCost: () => ({ source: 'external_api', rateKey: 'external_api', quantity: 1 }),
            execute: throwingExecute,
          }),
          throwingExecution,
          costs,
          new FirestoreApprovalRepository(store),
          new FirestoreApprovalPolicyRepository(store),
        );
        vi.spyOn(throwingExecution, 'outcome').mockRejectedValue(
          new Error('persistence unavailable'),
        );
        const throwTask = Object.assign({}, task, { id: 'throw-task' }) as never;
        await store.doc('tasks', 'throw-task').set({
          id: 'throw-task',
          agentId: 'agent',
          type: 'adhoc',
          status: 'running',
          spentUsd: '0',
          budgetUsdLimit: '1',
        });
        const throwCtx = { ...ctx, taskId: 'throw-task' };
        const thrown = await throwingDispatcher.dispatch({
          task: throwTask,
          step: 1,
          toolName: 'test.throwing',
          args: { value: 'x' },
          ctx: throwCtx,
          provenance: { plannerVersion: 1, promptVersion: 1, model: 'test' },
        });
        const thrownRetry = await throwingDispatcher.dispatch({
          task: throwTask,
          step: 2,
          toolName: 'test.throwing',
          args: { value: 'x' },
          ctx: throwCtx,
          provenance: { plannerVersion: 1, promptVersion: 1, model: 'test' },
        });
        expect(thrown.kind).toBe('rejected');
        expect(thrownRetry.kind).toBe('rejected');
        expect(throwingExecute).toHaveBeenCalledTimes(1);
        expect((await costs.totals()).heldUsd).toBe(0);
        expect((await costs.totals()).dailySpentUsd).toBeCloseTo(0.2);
        expect(
          (
            await store.collection('toolCalls').where('taskId', '==', 'throw-task').limit(1).get()
          ).docs[0]?.get('status'),
        ).toBe('executing');
      } finally {
        await disposeStore(store);
      }
    });
  },
);
