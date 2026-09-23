import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreOwnerNoticeRepository } from './owner-notices.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore owner dashboard notices', () => {
  let store: InstallationStore;
  let notices: FirestoreOwnerNoticeRepository;
  const agentId = randomUUID();
  const now = new Date('2026-09-23T12:00:00.000Z');

  beforeEach(async () => {
    store = emulatorStore(() => now);
    notices = new FirestoreOwnerNoticeRepository(store, agentId);
    await store.doc('agents', agentId).set({ id: agentId, timezone: 'UTC' });
  });

  afterEach(async () => {
    await disposeStore(store);
  });

  it('mirrors into an existing primary chat, but does not duplicate its own notice', async () => {
    const primaryId = randomUUID();
    const taskId = randomUUID();
    await Promise.all([
      store.doc('conversations', primaryId).set({
        id: primaryId,
        agentId,
        channel: 'chat',
        isPrimary: true,
        archivedAt: null,
        title: 'Primary',
      }),
      store.doc('tasks', taskId).set({ id: taskId, agentId }),
    ]);
    expect(await notices.primaryConversationId()).toBe(primaryId);
    expect(
      await notices.post({ text: 'Already here', sourceConversationId: primaryId }),
    ).toBeNull();
    expect(
      await notices.post({
        text: 'Approval needed',
        taskId,
        sourceConversationId: randomUUID(),
        extraParts: [{ type: 'approval-summary', approvalCount: 1 }],
      }),
    ).toEqual({ conversationId: primaryId });
    const messages = await store
      .collection('messages')
      .where('conversationId', '==', primaryId)
      .get();
    expect(messages.size).toBe(1);
    expect(messages.docs[0]?.get('taskId')).toBe(taskId);
    expect(messages.docs[0]?.get('parts')).toEqual([
      { type: 'text', text: 'Approval needed' },
      { type: 'approval-summary', approvalCount: 1 },
    ]);
    expect(
      (await store.collection('conversations').where('title', '==', 'Notifications').get()).size,
    ).toBe(0);
  });

  it('uses one assistant-owned Notifications chat before a primary exists', async () => {
    const first = await notices.post({ text: 'Task finished' });
    const second = await notices.post({ text: 'Another task finished' });
    expect(first?.conversationId).toBe(second?.conversationId);
    const chats = await store
      .collection('conversations')
      .where('title', '==', 'Notifications')
      .get();
    expect(chats.size).toBe(1);
    expect(chats.docs[0]?.get('trust')).toBe('assistant');
    expect(chats.docs[0]?.get('isPrimary')).toBe(false);
    expect((await store.collection('messages').get()).size).toBe(2);
  });

  it('reuses a migrated Notifications chat and rejects foreign tasks or active erasure', async () => {
    const legacyId = randomUUID();
    await store.doc('conversations', legacyId).set({
      id: legacyId,
      agentId,
      channel: 'chat',
      isPrimary: false,
      archivedAt: null,
      title: 'Notifications',
    });
    expect(await notices.post({ text: 'Recovered notice' })).toEqual({ conversationId: legacyId });
    expect(
      (await store.doc('notificationConversations', agentId).get()).get('conversationId'),
    ).toBe(legacyId);
    const foreignTaskId = randomUUID();
    await store.doc('tasks', foreignTaskId).set({ id: foreignTaskId, agentId: randomUUID() });
    await expect(notices.post({ text: 'foreign', taskId: foreignTaskId })).rejects.toThrow(
      'outside the configured installation',
    );
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    await expect(notices.post({ text: 'blocked' })).rejects.toThrow('Privacy erasure');
    expect((await store.collection('messages').get()).size).toBe(1);
  });

  it('writes owner.notify into its task chat without opening SQL', async () => {
    const conversationId = randomUUID();
    const taskId = randomUUID();
    await Promise.all([
      store.doc('conversations', conversationId).set({
        id: conversationId,
        agentId,
        channel: 'chat',
        isPrimary: false,
        archivedAt: null,
      }),
      store.doc('tasks', taskId).set({ id: taskId, agentId, conversationId }),
    ]);
    expect(await notices.postToolNotice({ text: 'Reminder text', taskId, conversationId })).toEqual(
      {
        conversationId,
      },
    );
    const messages = await store
      .collection('messages')
      .where('conversationId', '==', conversationId)
      .get();
    expect(messages.size).toBe(1);
    expect(messages.docs[0]?.data()).toMatchObject({
      taskId,
      role: 'assistant',
      origin: 'assistant',
      text: 'Reminder text',
      parts: [{ type: 'text', text: 'Reminder text' }],
    });
  });

  it('uses Notifications without a task chat and refuses foreign ownership or erasure', async () => {
    const taskId = randomUUID();
    await store.doc('tasks', taskId).set({ id: taskId, agentId, conversationId: null });
    const first = await notices.postToolNotice({ text: 'Time to check back', taskId });
    const second = await notices.postToolNotice({ text: 'Another check', taskId });
    expect(first.conversationId).toBe(second.conversationId);
    expect((await store.collection('messages').get()).size).toBe(2);

    const foreignTask = randomUUID();
    await store.doc('tasks', foreignTask).set({ id: foreignTask, agentId: randomUUID() });
    await expect(notices.postToolNotice({ text: 'No', taskId: foreignTask })).rejects.toThrow(
      'outside the configured installation',
    );
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    await expect(notices.postToolNotice({ text: 'Blocked', taskId })).rejects.toThrow(
      'Privacy erasure',
    );
    expect((await store.collection('messages').get()).size).toBe(2);
  });
});
