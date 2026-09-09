/** Test-only adapter contract. Imported by both suites; excluded from the runtime barrel. */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CostRepository, MessageRepository, ReminderRepository } from './contracts.js';
import type { Records } from './records.js';
import type { TaskRepository } from './task-lifecycle.js';

export interface CommandFixture {
  agentId: string;
  conversationId: string;
  taskId: string;
  reminderId: string;
  costs: CostRepository;
  leases: TaskRepository;
  messages: MessageRepository;
  reminders: ReminderRepository;
  patchTask(patch: Partial<Records['tasks']>): Promise<void>;
  readTask(): Promise<Records['tasks']>;
  messageCount(): Promise<number>;
  externalCounts(): Promise<{ hour: number; day: number }>;
  setTaskRatePolicy(hour: number | null, day: number | null): Promise<void>;
  dispose(): Promise<void>;
}

export function commandContract(
  name: string,
  fixture: () => Promise<CommandFixture>,
  skip = false,
) {
  describe.skipIf(skip)(name, () => {
    let f: CommandFixture;
    beforeEach(async () => {
      f = await fixture();
    });
    afterEach(async () => {
      await f?.dispose();
    });
    const input = () => ({
      agentId: f.agentId,
      conversationId: f.conversationId,
      trust: 'owner',
      type: 'adhoc',
      trigger: { source: 'internal', payload: { text: 'contract' } },
    });
    it('creates one task for concurrent delivery and preserves its initial defaults', async () => {
      const request = { ...input(), externalEventId: `event:${randomUUID()}`, title: 'One task' };
      const results = await Promise.all([
        f.leases.createTask(request),
        f.leases.createTask(request),
      ]);
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(results[0]?.task.id).toBe(results[1]?.task.id);
      expect(results[0]?.task).toMatchObject({
        status: 'pending',
        queueGeneration: 0,
        title: 'One task',
        maxSteps: 12,
        budgetUsdLimit: '0.5000',
        state: {},
        leaseToken: null,
      });
      await expect(f.leases.createTask({ ...request, agentId: randomUUID() })).rejects.toThrow(
        'another agent',
      );
    });
    it('scheduled creation cannot run early and a stale queue generation cannot claim it', async () => {
      const { task } = await f.leases.createTask({
        ...input(),
        runAfter: new Date(Date.now() + 60_000),
        maxSteps: 7,
        budgetUsdLimit: '0.25',
        plan: { steps: [] },
      });
      expect(task).toMatchObject({
        status: 'sleeping',
        maxSteps: 7,
        budgetUsdLimit: '0.2500',
        plan: { steps: [] },
      });
      expect(await f.leases.claim(task.id, 0)).toBeNull();
      expect(await f.leases.wakeTask(task.id)).toMatchObject({ queueGeneration: 1 });
      expect(await f.leases.claim(task.id, 0)).toBeNull();
      expect(await f.leases.claim(task.id, -1)).toBeNull();
      expect(await f.leases.claim(task.id, 1)).not.toBeNull();
    });
    it('enforces the external rate cap under concurrent creation and permits idempotent retries', async () => {
      const before = await f.externalCounts();
      await f.setTaskRatePolicy(before.hour + 1, before.day + 10);
      const requests = Array.from({ length: 4 }, () => ({
        ...input(),
        trust: 'unknown',
        externalEventId: randomUUID(),
      }));
      const results = await Promise.allSettled(
        requests.map((request) => f.leases.createTask(request)),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const result of results) {
        if (result.status === 'rejected') expect(result.reason.name).toBe('TaskRateLimitError');
      }
      const winner = results.findIndex((r) => r.status === 'fulfilled');
      const request = requests[winner];
      if (!request) throw new Error('No successful creation');
      expect((await f.leases.createTask(request)).created).toBe(false);
      expect((await f.leases.createTask(input())).created).toBe(true);
      expect(
        (await f.leases.createTask({ ...input(), trust: 'unknown', parentTaskId: f.taskId }))
          .created,
      ).toBe(true);
    });
    it('enforces a daily cap independently and permits explicitly unlimited policy', async () => {
      await f.setTaskRatePolicy(null, 0);
      await expect(f.leases.createTask({ ...input(), trust: 'known' })).rejects.toMatchObject({
        name: 'TaskRateLimitError',
      });
      await f.setTaskRatePolicy(null, null);
      expect((await f.leases.createTask({ ...input(), trust: 'known' })).created).toBe(true);
    });
    it('one worker wins a concurrent claim; future and terminal work cannot be claimed', async () => {
      const claims = await Promise.all([f.leases.claim(f.taskId), f.leases.claim(f.taskId)]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      await f.patchTask({
        status: 'sleeping',
        lockedUntil: null,
        leaseToken: null,
        runAfter: new Date(Date.now() + 60_000),
      });
      expect(await f.leases.claim(f.taskId)).toBeNull();
      await f.patchTask({ status: 'cancelled', lockedUntil: null, runAfter: null });
      expect(await f.leases.claim(f.taskId)).toBeNull();
    });
    it('reclaim fences the old worker from both renewal and checkpoint writes', async () => {
      const old = await f.leases.claim(f.taskId);
      if (!old) throw new Error('Missing fixture lease');
      await f.patchTask({ lockedUntil: new Date(0) });
      const current = await f.leases.claim(f.taskId);
      if (!current) throw new Error('Could not reclaim expired fixture lease');
      // Force identical millisecond timestamps: token equality must still fence the old worker.
      await f.patchTask({ lockedUntil: old.lockedUntil });
      current.lockedUntil = old.lockedUntil;
      expect(await f.leases.renew(old)).toBe(false);
      expect(await f.leases.checkpoint(old, { stale: true })).toBe(false);
      expect(await f.leases.renew(current)).toBe(true);
      expect(
        await f.leases.checkpoint(current, { phase: 'step-2' }, { progress: 'checkpoint' }),
      ).toBe(true);
      expect(await f.readTask()).toMatchObject({
        state: { phase: 'step-2' },
        progress: 'checkpoint',
        attempt: 0,
        reclaimCount: 0,
      });
    });
    it('cancellation invalidates an outstanding lease', async () => {
      const claimed = await f.leases.claim(f.taskId);
      if (!claimed) throw new Error('Missing fixture lease');
      await f.patchTask({ status: 'cancelled', lockedUntil: null });
      expect(await f.leases.renew(claimed)).toBe(false);
      expect(await f.leases.checkpoint(claimed, { stale: true })).toBe(false);
    });
    it('deduplicates channel messages under a concurrent delivery', async () => {
      const input = {
        conversationId: f.conversationId,
        role: 'user' as const,
        origin: 'owner' as const,
        text: 'hello',
        parts: [{ type: 'text', text: 'hello' }],
        channelMessageId: `delivery:${randomUUID()}`,
      };
      const rows = await Promise.all([f.messages.append(input), f.messages.append(input)]);
      expect(rows.filter(Boolean)).toHaveLength(1);
      expect(await f.messageCount()).toBe(1);
    });
    it('owner-scopes reminder cancellation, cancels queued work, and reports repeats truthfully', async () => {
      expect((await f.reminders.cancel(randomUUID(), f.reminderId)).cancelled).toBe(false);
      expect(await f.reminders.cancel(f.agentId, f.reminderId)).toMatchObject({
        cancelled: true,
        queuedTasksCancelled: 1,
      });
      expect((await f.readTask()).status).toBe('cancelled');
      expect((await f.reminders.cancel(f.agentId, f.reminderId)).cancelled).toBe(false);
    });
    it('sleep and approval parking fence the executor and preserve the resumed checkpoint', async () => {
      const lease = await f.leases.claim(f.taskId);
      if (!lease) throw new Error('Missing fixture lease');
      await f.patchTask({ reclaimCount: 7, attempt: 2 });
      expect(
        await f.leases.sleepTask(lease, { phase: 'paused' }, new Date(Date.now() + 60_000)),
      ).toBe(true);
      expect(await f.readTask()).toMatchObject({
        status: 'sleeping',
        attempt: 0,
        reclaimCount: 0,
        queueGeneration: 1,
      });
      expect(await f.leases.completeTask(lease, { status: 'done' })).toBe(false);
      expect(await f.leases.wakeTask(f.taskId)).toMatchObject({ id: f.taskId, queueGeneration: 2 });
      const resumed = await f.leases.claim(f.taskId);
      if (!resumed) throw new Error('Missing resumed lease');
      expect(await f.leases.parkForApproval(resumed, { phase: 'approval' }, ['a'])).toBe(true);
      expect(await f.readTask()).toMatchObject({
        status: 'waiting_approval',
        state: { phase: 'approval', pendingApprovals: ['a'] },
      });
    });
    it('bounded retries dead-letter and an owner-scoped budget increase clears a delivered final', async () => {
      const lease = await f.leases.claim(f.taskId);
      if (!lease) throw new Error('Missing fixture lease');
      expect(await f.leases.recordFailedAttempt(lease, 'transient')).toBe('retry');
      expect(await f.readTask()).toMatchObject({ status: 'sleeping', attempt: 1 });
      await f.patchTask({
        runAfter: new Date(0),
        attempt: 7,
        state: { phase: 'answer', pendingFinal: { text: 'old final' } },
      });
      const last = await f.leases.claim(f.taskId);
      if (!last) throw new Error('Missing retry lease');
      expect(await f.leases.recordFailedAttempt(last, 'persistent')).toBe('dead_letter');
      expect(await f.leases.markAttentionNotified(f.taskId)).toBe(true);
      expect(await f.leases.wakeTask(f.taskId, { agentId: randomUUID(), limit: 2 })).toBeNull();
      expect(await f.leases.wakeTask(f.taskId, { agentId: f.agentId, limit: 2 })).not.toBeNull();
      expect(await f.readTask()).toMatchObject({
        status: 'pending',
        state: { phase: 'answer' },
        budgetUsdLimit: '2.0000',
        attentionNotifiedAt: null,
      });
      expect(await f.leases.markAttentionNotified(f.taskId)).toBe(false);
    });
    it('concurrent recovery gives an expired task one new queue generation', async () => {
      const lease = await f.leases.claim(f.taskId);
      if (!lease) throw new Error('Missing fixture lease');
      await f.patchTask({ lockedUntil: new Date(0) });
      await Promise.all([f.leases.findDueTasks(100), f.leases.findDueTasks(100)]);
      expect(await f.readTask()).toMatchObject({
        status: 'pending',
        reclaimCount: 1,
        queueGeneration: 1,
      });
      expect(await f.leases.completeTask(lease, { status: 'done' })).toBe(false);
      expect(await f.leases.completeTask(f.taskId, { status: 'cancelled' })).toBe(true);
      expect(await f.leases.wakeTask(f.taskId)).toBeNull();
    });
    it('retries one reservation and settles its task and ledger exactly once', async () => {
      const input = {
        source: 'model' as const,
        taskId: f.taskId,
        estimatedUsd: 0.1,
        operationId: randomUUID(),
      };
      const [first, second] = await Promise.all([f.costs.reserve(input), f.costs.reserve(input)]);
      expect(first).toEqual(second);
      if (!first?.ok) throw new Error('Missing fixture reservation');
      await expect(f.costs.reserve({ ...input, estimatedUsd: 0.2 })).rejects.toThrow(
        'different work',
      );
      await Promise.all([
        f.costs.reconcile(first.reservationId, { usd: 0.07 }),
        f.costs.reconcile(first.reservationId, { usd: 0.07 }),
      ]);
      expect(Number((await f.readTask()).spentUsd)).toBe(0.07);
      expect((await f.costs.reserve(input)).ok).toBe(false);
    });
  });
}

export function taskFixture(input: {
  id: string;
  agentId: string;
  conversationId: string;
  reminderId: string;
}): Records['tasks'] {
  const now = new Date();
  return {
    id: input.id,
    agentId: input.agentId,
    conversationId: input.conversationId,
    createdAt: now,
    updatedAt: now,
    title: null,
    status: 'pending',
    progress: '',
    nextAction: '',
    archivedAt: null,
    trust: 'owner',
    type: 'adhoc',
    goalId: null,
    autonomyGrant: null,
    trigger: { payload: { scheduleId: input.reminderId } },
    externalEventId: null,
    plan: null,
    state: {},
    progressPercent: null,
    deadline: null,
    reflectEvery: null,
    lastReflectedAt: null,
    runAfter: null,
    lockedUntil: null,
    leaseToken: null,
    queueGeneration: 0,
    attempt: 0,
    reclaimCount: 0,
    maxSteps: 10,
    budgetUsdLimit: '1.00',
    spentUsd: '0',
    parentTaskId: null,
    attentionNotifiedAt: null,
  };
}
