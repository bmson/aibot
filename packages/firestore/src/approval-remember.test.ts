import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreApprovalRepository } from './approvals.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore approval remember flow', () => {
  let store: InstallationStore;
  let approvals: FirestoreApprovalRepository;

  beforeEach(async () => {
    store = emulatorStore();
    approvals = new FirestoreApprovalRepository(store);
    await store.doc('tasks', 'task').set({
      id: 'task',
      agentId: 'agent',
      type: 'chat_turn',
      status: 'waiting_approval',
      queueGeneration: 0,
    });
    await store.doc('toolCalls', 'tool').set({
      id: 'tool',
      taskId: 'task',
      toolName: 'gmail.send',
      status: 'awaiting_approval',
    });
    await store.doc('approvals', 'approval').set({
      id: 'approval',
      taskId: 'task',
      toolCallId: 'tool',
      shortCode: 'A7',
      summary: 'send email',
      payload: { to: ['friend@example.com'] },
      resolutionPayload: null,
      status: 'pending',
      requestedAt: new Date('2026-09-12T12:00:00.000Z'),
      resolvedAt: null,
      resolvedVia: null,
      expiresAt: new Date('2026-09-13T12:00:00.000Z'),
    });
  });

  afterEach(async () => {
    await disposeStore(store);
  });

  it('returns only an owner-scoped, linked pending approval', async () => {
    await expect(approvals.getRememberable('agent', 'approval')).resolves.toMatchObject({
      approval: { id: 'approval', status: 'pending' },
      toolName: 'gmail.send',
    });
    await expect(approvals.getRememberable('other-agent', 'approval')).resolves.toBeNull();

    await store.doc('toolCalls', 'tool').update({ taskId: 'other-task' });
    await expect(approvals.getRememberable('agent', 'approval')).resolves.toBeNull();
  });

  it('rejects a mismatched policy without resolving the approval', async () => {
    await expect(
      approvals.resolve({
        approvalId: 'approval',
        decision: 'approved',
        via: 'web',
        policy: {
          agentId: 'other-agent',
          toolName: 'gmail.send',
          templateKey: 'gmail.send.to_recipient',
          match: { recipient: 'friend@example.com' },
          effect: 'allow',
        },
      }),
    ).rejects.toThrow('task owner and tool');
    expect((await store.doc('approvals', 'approval').get()).get('status')).toBe('pending');
  });
});
