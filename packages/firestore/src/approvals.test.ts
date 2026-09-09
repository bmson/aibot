import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreApprovalRepository } from './approvals.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore approval command', () => {
  let store: InstallationStore, approvals: FirestoreApprovalRepository;
  beforeEach(async () => {
    store = emulatorStore();
    approvals = new FirestoreApprovalRepository(store);
    await store
      .doc('tasks', 'task')
      .set({ id: 'task', agentId: 'agent', status: 'waiting_approval', queueGeneration: 0 });
    await store
      .doc('toolCalls', 'tool')
      .set({ id: 'tool', taskId: 'task', toolName: 'email.send', status: 'pending' });
    await store.doc('approvals', 'approval').set({
      id: 'approval',
      taskId: 'task',
      toolCallId: 'tool',
      shortCode: 'A7',
      status: 'pending',
    });
  });
  afterEach(async () => {
    await disposeStore(store);
  });
  it('resolves a racing decision exactly once with the checkpoint wake and durable outbox', async () => {
    const results = await Promise.all([
      approvals.resolve({ approvalId: 'approval', decision: 'approved', via: 'web' }),
      approvals.resolve({ shortCode: 'A7', decision: 'denied', via: 'sms' }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const status = (await store.doc('approvals', 'approval').get()).get('status');
    expect((await store.doc('toolCalls', 'tool').get()).get('status')).toBe(status);
    expect((await store.doc('tasks', 'task').get()).get('queueGeneration')).toBe(1);
    expect((await store.collection('outbox').get()).size).toBe(1);
  });
  it('a late approval does not resurrect a cancelled task', async () => {
    await store.doc('tasks', 'task').update({ status: 'cancelled' });
    expect(
      (await approvals.resolve({ approvalId: 'approval', decision: 'approved', via: 'web' })).ok,
    ).toBe(true);
    expect((await store.doc('tasks', 'task').get()).get('status')).toBe('cancelled');
    expect((await store.collection('outbox').get()).size).toBe(0);
  });
  it('persists edited args and an owner/tool-scoped policy together, rejecting mismatches atomically', async () => {
    const input = {
      approvalId: 'approval',
      decision: 'approved' as const,
      via: 'web' as const,
      editedPayload: { body: 'edited' },
      policy: {
        agentId: 'agent',
        toolName: 'email.send',
        templateKey: 'recipient',
        match: { to: 'a@example.com' },
        effect: 'allow' as const,
      },
    };
    await expect(
      approvals.resolve({ ...input, policy: { ...input.policy, agentId: 'other' } }),
    ).rejects.toThrow('task owner');
    expect((await store.doc('approvals', 'approval').get()).get('status')).toBe('pending');
    expect((await approvals.resolve(input)).ok).toBe(true);
    expect((await store.doc('approvals', 'approval').get()).get('resolutionPayload')).toEqual({
      body: 'edited',
    });
    expect((await store.collection('approvalPolicies').get()).size).toBe(1);
  });
  it('ambiguous short codes do not resolve multiple requests', async () => {
    await store.doc('approvals', 'other').set({ id: 'other', shortCode: 'A7', status: 'pending' });
    expect(
      (await approvals.resolve({ shortCode: 'A7', decision: 'approved', via: 'sms' })).ok,
    ).toBe(false);
    expect((await store.doc('approvals', 'approval').get()).get('status')).toBe('pending');
  });
});
