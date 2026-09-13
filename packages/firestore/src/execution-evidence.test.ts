import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreExecutionEvidenceRepository } from './execution-evidence.js';
import { documentKey, type InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore execution evidence', () => {
  let store: InstallationStore;
  let repository: FirestoreExecutionEvidenceRepository;

  beforeEach(async () => {
    store = emulatorStore(() => new Date('2026-09-12T12:00:00Z'));
    repository = new FirestoreExecutionEvidenceRepository(store);
    await store
      .doc('tasks', 'task')
      .set({ id: 'task', agentId: 'owner', conversationId: 'conversation' });
    await store
      .doc('tasks', 'foreign-task')
      .set({ id: 'foreign-task', agentId: 'other', conversationId: 'conversation' });
    await store.doc('conversations', 'conversation').set({ id: 'conversation', agentId: 'owner' });
    await store.doc('toolCalls', 'call-1').set({
      id: 'call-1',
      taskId: 'task',
      step: 1,
      toolName: 'test.one',
      status: 'succeeded',
      args: {},
      result: { ok: true },
      error: null,
      createdAt: new Date('2026-09-12T12:00:01Z'),
    });
    await store.doc('toolCalls', 'call-2').set({
      id: 'call-2',
      taskId: 'task',
      step: 2,
      toolName: 'test.two',
      status: 'failed',
      args: {},
      result: null,
      error: 'nope',
      createdAt: new Date('2026-09-12T12:00:02Z'),
    });
  });

  afterEach(async () => disposeStore(store));

  it('scopes task evidence and fails closed at the bound', async () => {
    await expect(repository.taskEvidence({ agentId: 'other', taskId: 'task' })).rejects.toThrow(
      'owner scope',
    );
    await expect(
      repository.taskEvidence({ agentId: 'owner', taskId: 'task', maxRows: 1 }),
    ).rejects.toThrow('row bound');
    await expect(repository.taskEvidence({ agentId: 'owner', taskId: 'task' })).resolves.toEqual([
      expect.objectContaining({ id: 'call-1', step: 1 }),
      expect.objectContaining({ id: 'call-2', step: 2 }),
    ]);
  });

  it('does not accept a foreign conversation task as prior evidence', async () => {
    await expect(
      repository.conversationEvidence({
        agentId: 'owner',
        conversationId: 'conversation',
        excludeTaskId: 'task',
      }),
    ).resolves.toEqual([]);
  });

  it('finds an exact final beyond one message page without weakening outbound bounds', async () => {
    const messageBatch = store.db.batch();
    const messageIds = Array.from({ length: 121 }, (_, index) => `message-${index}`);
    const finalMessageId = messageIds.toSorted((a, b) =>
      documentKey(a).localeCompare(documentKey(b)),
    )[120];
    for (const id of messageIds) {
      messageBatch.set(store.doc('messages', id), {
        id,
        taskId: 'task',
        conversationId: 'conversation',
        role: 'assistant',
        origin: 'assistant',
        text: id === finalMessageId ? 'final' : `irrelevant-${id}`,
      });
    }
    await messageBatch.commit();
    expect(
      await repository.finalMessageExists({
        agentId: 'owner',
        taskId: 'task',
        conversationId: 'conversation',
        text: 'final',
      }),
    ).toBe(true);
    expect(
      await repository.finalMessageExists({
        agentId: 'owner',
        taskId: 'task',
        conversationId: 'conversation',
        text: 'missing final',
      }),
    ).toBe(false);

    const toolBatch = store.db.batch();
    for (let index = 0; index < 51; index += 1) {
      const id = `outbound-${index}`;
      toolBatch.set(store.doc('toolCalls', id), {
        id,
        taskId: 'task',
        step: index + 10,
        toolName: index === 50 ? 'gmail.send' : 'test.one',
        status: 'succeeded',
        args: {},
        result: {},
        error: null,
        createdAt: new Date(`2026-09-12T12:01:${String(index).padStart(2, '0')}Z`),
      });
    }
    await toolBatch.commit();
    await expect(repository.hasOutboundReply({ agentId: 'owner', taskId: 'task' })).rejects.toThrow(
      'outbound lookup exceeds',
    );
  });

  it('rejects a final-message target outside the task owner scope', async () => {
    await store
      .doc('conversations', 'foreign-conversation')
      .set({ id: 'foreign-conversation', agentId: 'other' });
    await store.doc('tasks', 'task').update({ conversationId: 'foreign-conversation' });
    await expect(
      repository.finalMessageExists({
        agentId: 'owner',
        taskId: 'task',
        conversationId: 'foreign-conversation',
        text: 'final',
      }),
    ).rejects.toThrow('conversation is outside the owner scope');
  });

  it('pages through more than 500 prior tasks while bounding actual evidence rows', async () => {
    const first = store.db.batch();
    for (let index = 0; index < 500; index += 1) {
      const id = `prior-${index}`;
      first.set(store.doc('tasks', id), { id, agentId: 'owner', conversationId: 'conversation' });
    }
    await first.commit();
    await store
      .doc('tasks', 'prior-500')
      .set({ id: 'prior-500', agentId: 'owner', conversationId: 'conversation' });
    await store.doc('toolCalls', 'late-evidence').set({
      id: 'late-evidence',
      taskId: 'prior-500',
      step: 1,
      toolName: 'test.late',
      status: 'succeeded',
      args: {},
      result: { ok: true },
      error: null,
      createdAt: new Date('2026-09-12T12:05:00Z'),
    });
    await expect(
      repository.conversationEvidence({
        agentId: 'owner',
        conversationId: 'conversation',
        excludeTaskId: 'task',
      }),
    ).resolves.toEqual([expect.objectContaining({ id: 'late-evidence' })]);
  });
  it('deduplicates notification finals for conversationless tasks and quality writes', async () => {
    await store.doc('tasks', 'task').update({ conversationId: null });
    await store.doc('messages', 'notification-final').set({
      id: 'notification-final',
      taskId: 'task',
      conversationId: 'conversation',
      role: 'assistant',
      origin: 'assistant',
      text: 'final',
    });
    expect(
      await repository.finalMessageExists({
        agentId: 'owner',
        taskId: 'task',
        conversationId: 'conversation',
        text: 'final',
      }),
    ).toBe(true);
    const input = {
      agentId: 'owner',
      check: {
        taskId: 'task',
        promptVersion: 1,
        plannerVersion: 1,
        blocked: false,
        unsupportedCount: 0,
        mustActRetries: 0,
        degradedSteps: 0,
        outputVerificationAttempted: false,
        outputVerificationRevised: false,
        outputVerificationUnavailable: false,
      },
    };
    expect(
      (
        await Promise.all([
          repository.recordResponseCheck(input),
          repository.recordResponseCheck(input),
        ])
      ).sort(),
    ).toEqual([false, true]);
    await expect(repository.recordResponseCheck({ ...input, agentId: 'other' })).rejects.toThrow(
      'owner scope',
    );
    expect((await store.collection('responseChecks').get()).size).toBe(1);
  });

  it('rejects mismatched evidence identity instead of quietly omitting a receipt', async () => {
    await store.doc('toolCalls', 'call-1').update({ id: 'different-record' });
    await expect(repository.taskEvidence({ agentId: 'owner', taskId: 'task' })).rejects.toThrow(
      'corrupt tool-call identity',
    );
  });
});
