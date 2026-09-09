/** Test-only adapter contract. Imported by both suites; excluded from the runtime barrel. */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  CostRepository,
  MessageRepository,
  ReminderRepository,
  TaskLeaseRepository,
} from './contracts.js';
import type { Records } from './records.js';

export interface CommandFixture {
  agentId: string;
  conversationId: string;
  taskId: string;
  reminderId: string;
  costs: CostRepository;
  leases: TaskLeaseRepository;
  messages: MessageRepository;
  reminders: ReminderRepository;
  patchTask(patch: Partial<Records['tasks']>): Promise<void>;
  readTask(): Promise<Records['tasks']>;
  messageCount(): Promise<number>;
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
