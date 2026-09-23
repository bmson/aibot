import { randomUUID } from 'node:crypto';
import { Timestamp } from '@google-cloud/firestore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreApplicationChatPersistence } from './application-chat.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore application chat persistence',
  () => {
    let store: InstallationStore;
    let repository: FirestoreApplicationChatPersistence;
    const agentId = randomUUID();
    let clock = Date.parse('2026-09-12T12:00:00.000Z');

    beforeEach(async () => {
      store = emulatorStore(() => {
        clock += 1000;
        return new Date(clock);
      });
      repository = new FirestoreApplicationChatPersistence(store);
      const createdAt = new Date(clock);
      await store.doc('agents', agentId).set({
        id: agentId,
        name: 'Assistant',
        timezone: 'UTC',
        createdAt,
        updatedAt: createdAt,
      });
    });

    afterEach(async () => {
      await disposeStore(store);
    });

    it('enforces ownership and preserves idempotent message delivery', async () => {
      const conversation = await repository.createConversation(agentId);
      await expect(repository.getConversation(randomUUID(), conversation.id)).resolves.toBeNull();
      await expect(
        repository.appendOwned(randomUUID(), {
          conversationId: conversation.id,
          role: 'user',
          origin: 'owner',
          parts: [],
          text: 'private',
        }),
      ).rejects.toThrow('chat not found');

      const input = {
        conversationId: conversation.id,
        role: 'user' as const,
        origin: 'owner' as const,
        parts: [{ type: 'text', text: 'hello' }],
        text: 'hello',
        channelMessageId: `chat-test:${randomUUID()}`,
      };
      await expect(repository.appendOwned(agentId, input)).resolves.toMatchObject({
        text: 'hello',
      });
      await expect(repository.appendOwned(agentId, input)).resolves.toBeUndefined();
      expect((await repository.listMessages(agentId, conversation.id))?.messages).toHaveLength(1);
    });

    it('returns one primary conversation to concurrent bootstrap callers', async () => {
      const [first, second] = await Promise.all([
        repository.getOrCreatePrimaryConversation(agentId),
        repository.getOrCreatePrimaryConversation(agentId),
      ]);
      const third = await repository.getOrCreatePrimaryConversation(agentId);

      expect(first.isPrimary).toBe(true);
      expect(first.archivedAt).toBeNull();
      expect(second.id).toBe(first.id);
      expect(third.id).toBe(first.id);
      expect(
        (await store.collection('conversations').where('isPrimary', '==', true).get()).size,
      ).toBe(1);
      expect((await store.doc('primaryConversations', agentId).get()).get('conversationId')).toBe(
        first.id,
      );
    });

    it('uses bounded keyset pages for conversation and message lists', async () => {
      const first = await repository.createConversation(agentId);
      const second = await repository.createConversation(agentId);
      const conversations = await repository.listConversations(agentId, {
        archived: false,
        limit: 1,
      });
      expect(conversations.conversations.map((row) => row.id)).toEqual([second.id]);
      expect(conversations.hasMore).toBe(true);
      expect(conversations.nextCursor).not.toBeNull();

      for (const text of ['one', 'two', 'three']) {
        await repository.appendOwned(agentId, {
          conversationId: first.id,
          role: 'user',
          origin: 'owner',
          parts: [{ type: 'text', text }],
          text,
        });
      }
      const tail = await repository.listMessages(agentId, first.id, { limit: 2 });
      expect(tail?.messages.map((row) => row.text)).toEqual(['two', 'three']);
      const cursor = tail?.messages[0];
      expect(cursor).toBeDefined();
      const next = await repository.listMessages(agentId, first.id, {
        limit: 1,
        after: cursor,
      });
      expect(next?.messages.map((row) => row.text)).toEqual(['three']);
      expect(next?.hasMore).toBe(false);
    });

    it('keeps native timestamp precision in message cursors', async () => {
      const conversation = await repository.createConversation(agentId);
      const firstId = randomUUID();
      const secondId = randomUUID();
      const seconds = Date.parse('2026-09-12T12:00:00Z') / 1_000;
      await Promise.all([
        store.doc('messages', firstId).set({
          id: firstId,
          conversationId: conversation.id,
          role: 'user',
          origin: 'owner',
          parts: [],
          text: 'first',
          hiddenAt: null,
          createdAt: new Timestamp(seconds, 123_456_000),
        }),
        store.doc('messages', secondId).set({
          id: secondId,
          conversationId: conversation.id,
          role: 'user',
          origin: 'owner',
          parts: [],
          text: 'second',
          hiddenAt: null,
          createdAt: new Timestamp(seconds, 123_789_000),
        }),
      ]);

      const firstPage = await repository.listMessages(agentId, conversation.id, { limit: 1 });
      expect(firstPage?.messages[0]).toMatchObject({
        id: secondId,
        createdAtExact: '2026-09-12T12:00:00.123789000Z',
      });

      const afterFirst = await repository.listMessages(agentId, conversation.id, {
        limit: 1,
        after: {
          createdAt: new Date('2026-09-12T12:00:00.123Z'),
          createdAtExact: '2026-09-12T12:00:00.123456Z',
          id: firstId,
        },
      });
      expect(afterFirst?.messages.map((message) => message.id)).toEqual([secondId]);
    });

    it('hides and restores only messages in an owned conversation', async () => {
      const conversation = await repository.createConversation(agentId);
      const message = await repository.appendOwned(agentId, {
        conversationId: conversation.id,
        role: 'user',
        origin: 'owner',
        parts: [{ type: 'text', text: 'private detail' }],
        text: 'private detail',
      });
      expect(message).toBeDefined();
      if (!message) throw new Error('message was not persisted');
      await expect(
        repository.setMessageHidden(randomUUID(), conversation.id, message.id, true),
      ).resolves.toBe(false);
      await expect(
        repository.setMessageHidden(agentId, conversation.id, message.id, true),
      ).resolves.toBe(true);
      await expect(repository.listMessages(agentId, conversation.id)).resolves.toMatchObject({
        messages: [],
      });
      await expect(
        repository.setMessageHidden(agentId, conversation.id, message.id, false),
      ).resolves.toBe(true);
      await expect(repository.listMessages(agentId, conversation.id)).resolves.toMatchObject({
        messages: [{ id: message.id }],
      });
    });

    it('checks active work transactionally before archiving', async () => {
      const conversation = await repository.createConversation(agentId);
      const taskId = randomUUID();
      await store.doc('tasks', taskId).set({
        id: taskId,
        agentId,
        conversationId: conversation.id,
        status: 'pending',
        type: 'adhoc',
      });
      await expect(repository.archiveConversation(agentId, conversation.id)).resolves.toBe(
        'active',
      );
      await store.doc('tasks', taskId).update({ status: 'done' });
      await expect(repository.archiveConversation(agentId, conversation.id)).resolves.toBe(
        'archived',
      );
      expect(
        (await repository.getConversation(agentId, conversation.id))?.archivedAt,
      ).toBeInstanceOf(Date);
      await expect(repository.countConversations(agentId, true)).resolves.toBe(1);
      await expect(
        repository.listConversations(agentId, { archived: true }),
      ).resolves.toMatchObject({
        conversations: [{ id: conversation.id }],
      });
    });

    it('atomically completes a leased direct task and fences stale retries', async () => {
      const conversation = await repository.createConversation(agentId);
      await store.doc('budgets', 'task_default').set({ scope: 'task_default', limitUsd: '1.2500' });
      const task = await repository.createDirectChatTask({
        agentId,
        conversationId: conversation.id,
        title: 'Direct reply',
      });
      expect(task).toMatchObject({
        status: 'running',
        conversationId: conversation.id,
        budgetUsdLimit: '1.2500',
      });

      const completed = await repository.completeDirectChatTask({
        agentId,
        task,
        status: 'done',
        progress: 'Completed',
        messages: [
          {
            conversationId: conversation.id,
            taskId: task.id,
            role: 'assistant',
            origin: 'assistant',
            parts: [{ type: 'text', text: 'Finished' }],
            text: 'Finished',
          },
        ],
      });
      expect(completed).toBe(true);
      await expect(
        repository.completeDirectChatTask({
          agentId,
          task,
          status: 'done',
          messages: [],
        }),
      ).resolves.toBe(false);
      await expect(repository.getTaskStatus(agentId, conversation.id, task.id)).resolves.toBe(
        'done',
      );
      expect((await repository.listMessages(agentId, conversation.id))?.messages).toMatchObject([
        { taskId: task.id, text: 'Finished' },
      ]);
    });

    it('deduplicates approvals requested directly and through their task', async () => {
      const taskId = randomUUID();
      const approvalId = randomUUID();
      await store.doc('tasks', taskId).set({ id: taskId, agentId, status: 'waiting_approval' });
      await store.doc('approvals', approvalId).set({
        id: approvalId,
        taskId,
        summary: 'Synthetic approval',
        status: 'pending',
        payload: {},
        expiresAt: new Date(clock + 60_000),
      });

      const hydrated = await repository.getHydrationState(agentId, {
        approvalIds: [approvalId],
        approvalTaskIds: [taskId],
        budgetTaskIds: [],
        suggestionIds: [],
      });
      expect(hydrated.approvals.map((approval) => approval.id)).toEqual([approvalId]);
      expect(hydrated.taskApprovals.map((approval) => approval.id)).toEqual([approvalId]);
    });

    it('fails explicitly when task approval hydration exceeds its bound', async () => {
      const taskId = randomUUID();
      await store.doc('tasks', taskId).set({ id: taskId, agentId, status: 'waiting_approval' });
      const batch = store.db.batch();
      for (let index = 0; index <= 200; index += 1) {
        const approvalId = randomUUID();
        batch.set(store.doc('approvals', approvalId), {
          id: approvalId,
          taskId,
          summary: `Synthetic approval ${index}`,
          status: 'pending',
          payload: {},
          expiresAt: new Date(clock + 60_000),
        });
      }
      await batch.commit();

      await expect(
        repository.getHydrationState(agentId, {
          approvalIds: [],
          approvalTaskIds: [taskId],
          budgetTaskIds: [],
          suggestionIds: [],
        }),
      ).rejects.toThrow('Approval hydration exceeds bounded page size');
    });
  },
);
