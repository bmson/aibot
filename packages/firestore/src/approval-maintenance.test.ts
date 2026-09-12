import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreApprovalRepository } from './approvals.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore approval maintenance', () => {
  let store: InstallationStore;
  let approvals: FirestoreApprovalRepository;
  let now: Date;

  beforeEach(() => {
    now = new Date('2026-09-12T12:00:00Z');
    store = emulatorStore(() => now);
    approvals = new FirestoreApprovalRepository(store);
  });

  afterEach(async () => {
    await disposeStore(store);
  });

  async function seedTask(
    taskId: string,
    approvalIds: string[],
    status: string = 'waiting_approval',
    state: unknown = { pendingApprovals: approvalIds.map((approvalId) => ({ approvalId })) },
  ) {
    await store.doc('tasks', taskId).set({
      id: taskId,
      agentId: 'agent',
      status,
      state,
      updatedAt: now,
      queueGeneration: 0,
      attempt: 3,
      runAfter: null,
      lockedUntil: new Date(now.getTime() - 60_000),
      leaseToken: 'stale-lease',
      attentionNotifiedAt: now,
    });
  }

  async function seedApproval(
    approvalId: string,
    taskId: string,
    toolCallId: string,
    over: Partial<{ status: string; expiresAt: Date; toolTaskId: string }> = {},
  ) {
    await store.doc('approvals', approvalId).set({
      id: approvalId,
      status: over.status ?? 'pending',
      expiresAt: over.expiresAt ?? new Date(now.getTime() - 1_000),
      taskId,
      toolCallId,
      resolvedAt: null,
    });
    await store.doc('toolCalls', toolCallId).set({
      id: toolCallId,
      taskId: over.toolTaskId ?? taskId,
      status: 'pending',
    });
  }

  async function outboxCount(taskId: string) {
    return (await store.collection('outbox').where('taskId', '==', taskId).get()).size;
  }

  it('converges concurrent expiry and owner resolution to one terminal decision and wake', async () => {
    const taskId = randomUUID();
    const approvalId = randomUUID();
    const toolCallId = randomUUID();
    await seedTask(taskId, [approvalId]);
    await seedApproval(approvalId, taskId, toolCallId);

    const [expired, resolved] = await Promise.all([
      approvals.expireStale(200, now),
      approvals.resolve({ approvalId, decision: 'approved', via: 'web' }),
    ]);
    expect(expired.length + Number(resolved.ok)).toBe(1);
    expect((await store.doc('approvals', approvalId).get()).get('status')).toEqual(
      expect.stringMatching(/^(approved|expired)$/),
    );
    expect((await store.doc('tasks', taskId).get()).get('queueGeneration')).toBe(1);
    expect(await outboxCount(taskId)).toBe(1);
  }, 30_000);

  it('expires multiple approvals for one task but emits one generation and wake', async () => {
    const taskId = randomUUID();
    const approvalIds = [randomUUID(), randomUUID()];
    await seedTask(taskId, approvalIds);
    await Promise.all(
      approvalIds.map((approvalId) => seedApproval(approvalId, taskId, randomUUID())),
    );

    const wakes = await approvals.expireStale(200, now);
    expect((await store.doc('tasks', taskId).get()).get('attentionNotifiedAt')).toBeNull();
    expect(wakes).toEqual([{ taskId, generation: 1 }]);
    expect(await outboxCount(taskId)).toBe(1);
    expect((await store.doc('tasks', taskId).get()).get('queueGeneration')).toBe(1);
    for (const approvalId of approvalIds)
      expect((await store.doc('approvals', approvalId).get()).get('status')).toBe('expired');
  }, 30_000);

  it('fails closed for missing, malformed, and foreign checkpoint approvals', async () => {
    const missingTask = randomUUID();
    const malformedTask = randomUUID();
    const foreignTask = randomUUID();
    const foreignApproval = randomUUID();
    await seedTask(missingTask, ['missing-approval']);
    await seedTask(malformedTask, [], 'waiting_approval', { pendingApprovals: 'bad' });
    await seedTask(foreignTask, [foreignApproval]);
    await seedApproval(foreignApproval, randomUUID(), randomUUID(), { status: 'approved' });

    expect(await approvals.resumeResolved(200, now)).toEqual([]);
    for (const taskId of [missingTask, malformedTask, foreignTask]) {
      expect((await store.doc('tasks', taskId).get()).get('status')).toBe('waiting_approval');
      expect(await outboxCount(taskId)).toBe(0);
    }
  });

  it('does not resurrect cancelled tasks and wakes a stale waiting checkpoint once approvals resolve', async () => {
    const cancelledTask = randomUUID();
    const staleTask = randomUUID();
    const cancelledApproval = randomUUID();
    const staleApproval = randomUUID();
    await seedTask(cancelledTask, [cancelledApproval], 'cancelled');
    await seedApproval(cancelledApproval, cancelledTask, randomUUID(), { status: 'approved' });
    await seedTask(staleTask, [staleApproval]);
    await seedApproval(staleApproval, staleTask, randomUUID(), { status: 'denied' });

    const wakes = await approvals.resumeResolved(200, now);
    expect(wakes).toEqual([{ taskId: staleTask, generation: 1 }]);
    expect((await store.doc('tasks', cancelledTask).get()).get('status')).toBe('cancelled');
    expect((await store.doc('tasks', staleTask).get()).get('status')).toBe('pending');
    expect((await store.doc('tasks', staleTask).get()).get('leaseToken')).toBeNull();
    expect(await outboxCount(cancelledTask)).toBe(0);
    expect(await outboxCount(staleTask)).toBe(1);
  });

  it('allocates recovery pages durably across repository instances', async () => {
    const firstTask = `a-${randomUUID()}`;
    const secondTask = `b-${randomUUID()}`;
    const firstApproval = randomUUID();
    const secondApproval = randomUUID();
    await seedTask(firstTask, [firstApproval]);
    await seedTask(secondTask, [secondApproval]);
    await seedApproval(firstApproval, firstTask, randomUUID());
    await seedApproval(secondApproval, secondTask, randomUUID(), { status: 'approved' });

    expect(await approvals.resumeResolved(1, now)).toEqual([]);
    const nextRepository = new FirestoreApprovalRepository(store);
    expect(await nextRepository.resumeResolved(1, now)).toEqual([
      { taskId: secondTask, generation: 1 },
    ]);
    expect(await outboxCount(secondTask)).toBe(1);
  });

  it('wraps a stale recovery cursor in the same allocation', async () => {
    const taskId = `a-${randomUUID()}`;
    const approvalId = randomUUID();
    await seedTask(taskId, [approvalId]);
    await seedApproval(approvalId, taskId, randomUUID(), { status: 'approved' });
    await store.doc('coordination', 'approval-recovery-cursor').set({
      cursor: 'zzzz-stale-cursor',
      updatedAt: now,
    });

    expect(await approvals.resumeResolved(1, now)).toEqual([{ taskId, generation: 1 }]);
    expect(await outboxCount(taskId)).toBe(1);
  });
});
