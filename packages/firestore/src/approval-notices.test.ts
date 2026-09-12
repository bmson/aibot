import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreApprovalRepository } from './approvals.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore approval notices', () => {
  let store: InstallationStore;
  let approvals: FirestoreApprovalRepository;
  const now = new Date('2026-09-12T12:00:00.000Z');

  beforeEach(() => {
    store = emulatorStore(() => now);
    approvals = new FirestoreApprovalRepository(store);
  });

  afterEach(async () => {
    await disposeStore(store);
  });

  async function seedTask(taskId = randomUUID(), status = 'waiting_approval') {
    await store.doc('tasks', taskId).set({
      id: taskId,
      agentId: 'agent',
      status,
      conversationId: `conversation-${taskId}`,
      state: {},
      updatedAt: now,
      queueGeneration: 0,
      attempt: 0,
    });
    return taskId;
  }

  function input(taskId: string, toolName = 'test.dispatch') {
    return {
      taskId,
      step: 4,
      toolName,
      args: { recipient: 'owner' },
      decision: { riskTier: 'high', reason: 'notice test' },
      summary: 'Please approve this test action',
    };
  }

  async function backdate(approvalId: string, requestedAt: Date, notifiedChannels?: string[]) {
    await store.doc('approvals', approvalId).update({
      requestedAt,
      ...(notifiedChannels ? { notifiedChannels } : {}),
    });
  }

  it('creates complete linked records with a 24 hour TTL and durable random code counter', async () => {
    const taskId = await seedTask(undefined, 'pending');
    const created = await approvals.create(input(taskId));
    const [tool, approval, counter] = await Promise.all([
      store.doc('toolCalls', created.toolCallId).get(),
      store.doc('approvals', created.approvalId).get(),
      store.doc('coordination', 'approval-codes').get(),
    ]);

    expect(created.shortCode).toMatch(/^A1[A-HJ-NP-Z]{2}$/);
    expect(tool.data()).toMatchObject({
      id: created.toolCallId,
      taskId,
      status: 'awaiting_approval',
      risk: 'approval',
      approvalId: created.approvalId,
    });
    expect(approval.data()).toMatchObject({
      id: created.approvalId,
      taskId,
      toolCallId: created.toolCallId,
      status: 'pending',
      notifiedChannels: [],
    });
    expect(approval.get('expiresAt').toDate().getTime()).toBe(now.getTime() + 24 * 60 * 60 * 1000);
    expect(counter.get('next')).toBe(2);
  });

  it('serializes concurrent creates and never reuses numeric codes', async () => {
    const taskIds = await Promise.all([
      seedTask(undefined, 'pending'),
      seedTask(undefined, 'pending'),
    ]);
    const created = await Promise.all(taskIds.map((taskId) => approvals.create(input(taskId))));
    expect(created.map((row) => row.shortCode).sort()).toEqual([
      expect.stringMatching(/^A1[A-HJ-NP-Z]{2}$/),
      expect.stringMatching(/^A2[A-HJ-NP-Z]{2}$/),
    ]);
    expect(new Set(created.map((row) => row.approvalId)).size).toBe(2);
    expect(new Set(created.map((row) => row.toolCallId)).size).toBe(2);
  });

  it('refuses to bootstrap a counter over historical approvals', async () => {
    const taskId = await seedTask(undefined, 'pending');
    await store.doc('approvals', randomUUID()).set({
      id: randomUUID(),
      status: 'approved',
      shortCode: 'A900ZZ',
      taskId,
      toolCallId: randomUUID(),
      requestedAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    await expect(approvals.create(input(taskId))).rejects.toThrow('high-water mark');
  });

  it('lists old pending notices grouped by task and preserves notice order', async () => {
    const taskId = await seedTask();
    const first = await approvals.create(input(taskId, 'test.first'));
    const second = await approvals.create(input(taskId, 'test.second'));
    const notified = await approvals.create(input(taskId, 'test.notified'));
    const future = await approvals.create(input(taskId, 'test.future'));
    await backdate(first.approvalId, new Date('2026-09-12T11:00:00.000Z'));
    await backdate(second.approvalId, new Date('2026-09-12T11:01:00.000Z'), ['owner']);
    await backdate(notified.approvalId, new Date('2026-09-12T11:02:00.000Z'), ['conversation']);
    await backdate(future.approvalId, new Date('2026-09-12T11:59:00.000Z'));

    const groups = await approvals.listStalledNotices({ now, olderThanMinutes: 5 });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.task.id).toBe(taskId);
    expect(groups[0]?.notices.map((notice) => notice.id)).toEqual([
      first.approvalId,
      second.approvalId,
    ]);
    expect(groups[0]?.notices.map((notice) => notice.toolName)).toEqual([
      'test.first',
      'test.second',
    ]);
    expect(
      groups[0]?.notices.every((notice) => notice.notifiedChannels.includes('conversation')),
    ).toBe(false);
  });

  it('advances a durable cursor past an ineligible notice', async () => {
    const taskId = await seedTask();
    const ineligible = await approvals.create(input(taskId, 'test.ineligible'));
    const eligible = await approvals.create(input(taskId, 'test.eligible'));
    await backdate(ineligible.approvalId, new Date('2026-09-12T10:00:00.000Z'), ['conversation']);
    await backdate(eligible.approvalId, new Date('2026-09-12T11:00:00.000Z'));

    expect(await approvals.listStalledNotices({ batch: 1, now })).toEqual([]);
    const nextRepository = new FirestoreApprovalRepository(store);
    const groups = await nextRepository.listStalledNotices({ batch: 1, now });
    expect(groups[0]?.notices.map((notice) => notice.id)).toEqual([eligible.approvalId]);
  });

  it('unions concurrent notification legs and preserves arbitrary channels', async () => {
    const taskId = await seedTask();
    const created = await approvals.create(input(taskId));
    await store.doc('approvals', created.approvalId).update({ notifiedChannels: ['custom'] });
    await Promise.all([
      approvals.markNotified([created.approvalId], ['owner']),
      approvals.markNotified([created.approvalId], ['conversation']),
    ]);
    expect(
      (await store.doc('approvals', created.approvalId).get()).get('notifiedChannels'),
    ).toEqual(['owner', 'conversation', 'custom']);

    await approvals.markNotified([created.approvalId], ['new-custom']);
    await store.doc('approvals', created.approvalId).update({ status: 'approved' });
    await approvals.markNotified([created.approvalId], ['owner', 'conversation']);
    expect(
      (await store.doc('approvals', created.approvalId).get()).get('notifiedChannels'),
    ).toEqual(['owner', 'conversation', 'custom', 'new-custom']);
  });
});
