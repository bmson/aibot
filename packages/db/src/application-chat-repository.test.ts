import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresApplicationChatPersistence } from './application-chat-repository.js';
import { createDb, type Db } from './client.js';
import { conversations, messages, tasks } from './schema.js';

describe('PostgreSQL application chat persistence', () => {
  let db: Db;
  const conversationIds: string[] = [];

  beforeAll(() => {
    db = createDb(
      process.env.DATABASE_URL ?? 'postgres://assistant@127.0.0.1:55432/assistant_test',
    );
  });

  afterAll(async () => {
    if (conversationIds.length) {
      await db.delete(messages).where(inArray(messages.conversationId, conversationIds));
      await db.delete(tasks).where(inArray(tasks.conversationId, conversationIds));
      await db.delete(conversations).where(inArray(conversations.id, conversationIds));
    }
    await db.$client.end();
  });

  it('enforces ownership and preserves idempotent message delivery', async () => {
    const repository = createPostgresApplicationChatPersistence(db);
    const agent = await repository.resolveAgent();
    const conversation = await repository.createConversation(agent.id);
    conversationIds.push(conversation.id);

    await expect(repository.getConversation(randomUUID(), conversation.id)).resolves.toBeNull();
    await expect(
      repository.appendOwned(randomUUID(), {
        conversationId: conversation.id,
        role: 'user',
        origin: 'owner',
        parts: [{ type: 'text', text: 'private' }],
        text: 'private',
      }),
    ).rejects.toThrow('chat not found');

    const channelMessageId = `chat-test:${randomUUID()}`;
    const input = {
      conversationId: conversation.id,
      role: 'user' as const,
      origin: 'owner' as const,
      parts: [{ type: 'text', text: 'hello' }],
      text: 'hello',
      channelMessageId,
    };
    const first = await repository.appendOwned(agent.id, input);
    expect(first?.text).toBe('hello');
    await expect(repository.appendOwned(agent.id, input)).resolves.toBeUndefined();
    expect((await repository.listMessages(agent.id, conversation.id))?.messages).toHaveLength(1);
  });

  it('uses a chronological keyset cursor and never leaks another owner’s chat', async () => {
    const repository = createPostgresApplicationChatPersistence(db);
    const agent = await repository.resolveAgent();
    const conversation = await repository.createConversation(agent.id);
    conversationIds.push(conversation.id);
    for (const text of ['one', 'two', 'three']) {
      await repository.appendOwned(agent.id, {
        conversationId: conversation.id,
        role: 'user',
        origin: 'owner',
        parts: [{ type: 'text', text }],
        text,
      });
    }

    const initial = await repository.listMessages(agent.id, conversation.id, { limit: 2 });
    expect(initial?.messages.map((message) => message.text)).toEqual(['two', 'three']);
    const first = initial?.messages[0];
    expect(first).toBeDefined();
    const page = await repository.listMessages(agent.id, conversation.id, {
      limit: 1,
      after: first,
    });
    expect(page?.messages.map((message) => message.text)).toEqual(['three']);
    expect(page?.hasMore).toBe(false);
    await expect(
      repository.listMessages(randomUUID(), conversation.id, { limit: 2 }),
    ).resolves.toBeNull();
  });

  it('hides and restores messages through the owner-scoped repository', async () => {
    const repository = createPostgresApplicationChatPersistence(db);
    const agent = await repository.resolveAgent();
    const conversation = await repository.createConversation(agent.id);
    conversationIds.push(conversation.id);
    const message = await repository.appendOwned(agent.id, {
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
      repository.setMessageHidden(agent.id, conversation.id, message.id, true),
    ).resolves.toBe(true);
    await expect(repository.listMessages(agent.id, conversation.id)).resolves.toMatchObject({
      messages: [],
    });
    await expect(
      repository.setMessageHidden(agent.id, conversation.id, message.id, false),
    ).resolves.toBe(true);
  });

  it('refuses to archive a primary or active conversation', async () => {
    const repository = createPostgresApplicationChatPersistence(db);
    const agent = await repository.resolveAgent();
    const conversation = await repository.createConversation(agent.id);
    conversationIds.push(conversation.id);
    const [task] = await db
      .insert(tasks)
      .values({
        agentId: agent.id,
        conversationId: conversation.id,
        type: 'adhoc',
        trust: 'owner',
      })
      .returning({ id: tasks.id });
    expect(task).toBeDefined();
    await expect(repository.archiveConversation(agent.id, conversation.id)).resolves.toBe('active');
    if (task)
      await db
        .update(tasks)
        .set({ status: 'done' })
        .where(inArray(tasks.id, [task.id]));
    await expect(repository.archiveConversation(agent.id, conversation.id)).resolves.toBe(
      'archived',
    );
    expect(
      (await repository.getConversation(agent.id, conversation.id))?.archivedAt,
    ).toBeInstanceOf(Date);
  });

  it('fences a direct chat completion and persists its reply atomically', async () => {
    const repository = createPostgresApplicationChatPersistence(db);
    const agent = await repository.resolveAgent();
    const conversation = await repository.createConversation(agent.id);
    conversationIds.push(conversation.id);
    const task = await repository.createDirectChatTask({
      agentId: agent.id,
      conversationId: conversation.id,
      title: 'Explain a rainbow',
    });
    expect(task.status).toBe('running');
    const completion = {
      agentId: agent.id,
      task,
      status: 'done' as const,
      messages: [
        {
          conversationId: conversation.id,
          taskId: task.id,
          role: 'assistant' as const,
          origin: 'assistant' as const,
          parts: [{ type: 'text', text: 'Light bends through water.' }],
          text: 'Light bends through water.',
        },
      ],
    };
    await expect(repository.completeDirectChatTask(completion)).resolves.toBe(true);
    await expect(repository.completeDirectChatTask(completion)).resolves.toBe(false);
    expect((await repository.listMessages(agent.id, conversation.id))?.messages).toMatchObject([
      { taskId: task.id, text: 'Light bends through water.' },
    ]);
  });
});
