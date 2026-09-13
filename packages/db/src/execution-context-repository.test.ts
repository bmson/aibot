import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import { createPostgresExecutionContextRepository } from './execution-context-repository.js';
import { conversations, messages, tasks } from './schema.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://assistant@127.0.0.1:55432/assistant_test';

describe('PostgreSQL execution context repository', () => {
  let db: Db;
  let agentId: string;
  const conversationIds: string[] = [];
  const taskIds: string[] = [];

  beforeEach(async () => {
    db = createDb(DATABASE_URL);
    const [agent] = await db.query.agents.findMany({ columns: { id: true }, limit: 1 });
    if (!agent) throw new Error('Execution context tests require the seeded test agent');
    agentId = agent.id;
  });

  afterEach(async () => {
    if (conversationIds.length) {
      await db.delete(messages).where(inArray(messages.conversationId, conversationIds));
    }
    if (taskIds.length) {
      await db.delete(tasks).where(inArray(tasks.id, taskIds));
    }
    if (conversationIds.length) {
      await db.delete(conversations).where(inArray(conversations.id, conversationIds));
    }
    conversationIds.length = 0;
    taskIds.length = 0;
    await db.$client.end();
  });

  async function makeConversation(channel: 'chat' | 'email'): Promise<string> {
    const [row] = await db
      .insert(conversations)
      .values({ agentId, channel, trust: 'owner', title: `xtest-execution-context-${channel}` })
      .returning({ id: conversations.id });
    if (!row) throw new Error('Failed to create conversation');
    conversationIds.push(row.id);
    return row.id;
  }

  async function addMessage(input: {
    conversationId: string;
    id?: string;
    at: Date;
    role?: 'user' | 'assistant' | 'system';
    origin?: 'owner' | 'known_contact';
    text: string;
    channelMessageId?: string;
  }): Promise<string> {
    const id = input.id ?? randomUUID();
    await db.insert(messages).values({
      id,
      conversationId: input.conversationId,
      role: input.role ?? 'user',
      origin:
        input.origin ??
        (input.role === 'assistant' ? 'assistant' : input.role === 'system' ? 'system' : 'owner'),
      parts: [],
      text: input.text,
      createdAt: input.at,
      channelMessageId: input.channelMessageId,
    });
    return id;
  }

  it('scopes startup and event-message reads to the owning agent and conversation', async () => {
    const repository = createPostgresExecutionContextRepository(db);
    const emailId = await makeConversation('email');
    const channelMessageId = `gmail:${randomUUID()}`;
    await addMessage({
      conversationId: emailId,
      at: new Date('2026-09-12T10:00:00Z'),
      text: 'event payload',
      channelMessageId,
    });

    await expect(repository.getAgent(agentId)).resolves.toMatchObject({ id: agentId });
    await expect(repository.getAgent(randomUUID())).resolves.toBeNull();
    await expect(repository.getTask(agentId, randomUUID())).resolves.toBeNull();
    await expect(repository.getGoalStopState(agentId, randomUUID())).resolves.toBeNull();
    await expect(
      repository.getInboundMessage({
        agentId,
        conversationId: emailId,
        channelMessageId,
      }),
    ).resolves.toEqual({ text: 'event payload' });
    await expect(
      repository.getInboundMessage({
        agentId: randomUUID(),
        conversationId: emailId,
        channelMessageId,
      }),
    ).resolves.toBeNull();
  });

  it('returns the latest 20 eligible messages before the cutoff from an owned email thread', async () => {
    const repository = createPostgresExecutionContextRepository(db);
    const emailId = await makeConversation('email');
    for (let index = 0; index < 25; index += 1) {
      await addMessage({
        conversationId: emailId,
        at: new Date(Date.UTC(2026, 8, 12, 10, index)),
        text: `history-${index}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
      });
    }
    await addMessage({
      conversationId: emailId,
      at: new Date('2026-09-12T10:25:00Z'),
      text: 'system-row',
      role: 'system',
    });
    await addMessage({
      conversationId: emailId,
      at: new Date('2026-09-12T12:00:00Z'),
      text: 'after-cutoff',
    });

    const rows = await repository.seedHistory({
      agentId,
      conversationId: emailId,
      before: new Date('2026-09-12T11:00:00Z'),
    });
    expect(rows).toHaveLength(20);
    expect(rows.map((row) => row.text)).toEqual(
      Array.from({ length: 20 }, (_, index) => `history-${index + 5}`),
    );
    await expect(
      repository.seedHistory({
        agentId: randomUUID(),
        conversationId: emailId,
        before: new Date('2026-09-12T11:00:00Z'),
      }),
    ).resolves.toEqual([]);
  });

  it('uses a stable timestamp/id cursor and refuses email folding', async () => {
    const repository = createPostgresExecutionContextRepository(db);
    const chatId = await makeConversation('chat');
    const emailId = await makeConversation('email');
    const at = new Date('2026-09-12T10:00:00Z');
    const ids = [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
    ];
    for (const [index, id] of ids.entries()) {
      await addMessage({ conversationId: chatId, id, at, text: `tie-${index}` });
    }
    await addMessage({
      conversationId: chatId,
      id: '00000000-0000-4000-8000-000000000004',
      at,
      text: 'known contact in chat',
      origin: 'known_contact',
    });
    await addMessage({ conversationId: emailId, at, text: 'email correction' });

    await expect(
      repository.getLatestOwnerReplyCursor({ agentId, conversationId: chatId }),
    ).resolves.toEqual({
      cursor: { createdAt: at, id: '00000000-0000-4000-8000-000000000004' },
    });
    const newer = await repository.getOwnerRepliesAfter({
      agentId,
      conversationId: chatId,
      after: { createdAt: at, id: ids[0] },
    });
    expect(newer.map((row) => row.id)).toEqual(ids.slice(1));
    const last = newer.at(-1);
    if (!last) throw new Error('Expected tied owner replies');
    await expect(
      repository.getOwnerRepliesAfter({
        agentId,
        conversationId: chatId,
        after: { createdAt: last.createdAt, id: last.id },
      }),
    ).resolves.toEqual([]);
    await expect(
      repository.getOwnerRepliesAfter({
        agentId,
        conversationId: emailId,
        after: { createdAt: new Date(0) },
      }),
    ).resolves.toEqual([]);
  });

  it('bounds only replies after the cursor and rejects overflow instead of dropping it', async () => {
    const repository = createPostgresExecutionContextRepository(db);
    const chatId = await makeConversation('chat');
    const cursorAt = new Date('2026-09-12T10:00:00Z');
    for (let index = 0; index < 250; index += 1) {
      await addMessage({
        conversationId: chatId,
        at: new Date(cursorAt.getTime() - 250_000 + index * 1000),
        text: `old-${index}`,
      });
    }
    for (let index = 0; index < 2; index += 1) {
      await addMessage({
        conversationId: chatId,
        at: new Date(cursorAt.getTime() + (index + 1) * 1000),
        text: `new-${index}`,
      });
    }
    await expect(
      repository.getOwnerRepliesAfter({
        agentId,
        conversationId: chatId,
        after: { createdAt: cursorAt },
      }),
    ).resolves.toHaveLength(2);

    for (let index = 2; index < 201; index += 1) {
      await addMessage({
        conversationId: chatId,
        at: new Date(cursorAt.getTime() + (index + 1) * 1000),
        text: `new-${index}`,
      });
    }
    await expect(
      repository.getOwnerRepliesAfter({
        agentId,
        conversationId: chatId,
        after: { createdAt: cursorAt },
      }),
    ).rejects.toThrow('Owner reply window exceeded 200 messages');
  });

  it('classifies structured and task-owned notices without trusting foreign tasks', async () => {
    const repository = createPostgresExecutionContextRepository(db);
    const conversationId = await makeConversation('chat');
    const [task] = await db
      .insert(tasks)
      .values({ agentId, conversationId, type: 'scheduled', status: 'done', trust: 'owner' })
      .returning({ id: tasks.id });
    if (!task) throw new Error('Failed to create task');
    taskIds.push(task.id);
    const rows = [
      { id: 'structured', role: 'assistant', taskId: null, parts: [{ type: 'notice' }] },
      {
        id: 'proactive',
        role: 'assistant',
        taskId: null,
        parts: [{ type: 'data-card', data: { kind: 'proactive-alert' } }],
      },
      { id: 'unknown', role: 'assistant', taskId: null, parts: [{ type: 42 }, null] },
      { id: 'scheduled', role: 'assistant', taskId: task.id, parts: [] },
    ];

    await expect(repository.noticeIds(agentId, rows)).resolves.toEqual(
      new Set(['structured', 'proactive', 'scheduled']),
    );
    await expect(repository.noticeIds(randomUUID(), rows)).resolves.toEqual(
      new Set(['structured', 'proactive']),
    );
  });
});
