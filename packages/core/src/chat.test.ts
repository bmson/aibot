import { conversations, createDb, type Db, messages, tasks } from '@assistant/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createChatTask,
  decodeMessageCursor,
  encodeMessageCursor,
  ensureChatConversation,
  finishTask,
  getAgent,
} from './chat.js';
import { completeTask, findDueTasks } from './workflow/machine.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

let db: Db;
let dbUp = false;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    await getAgent(db);
    dbUp = true;
  } catch {
    console.warn('chat.test: database unreachable or unseeded — skipping integration tests');
  }
});

afterAll(async () => {
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('message cursors', () => {
  it('round-trips a timestamp and UUID tie breaker', () => {
    const cursor = {
      createdAt: new Date('2026-07-17T18:00:00.123Z'),
      id: '123e4567-e89b-42d3-a456-426614174000',
    };

    expect(decodeMessageCursor(encodeMessageCursor(cursor))).toEqual(cursor);
  });

  it('rejects malformed and non-UUID cursors', () => {
    expect(decodeMessageCursor(undefined)).toBeUndefined();
    expect(decodeMessageCursor('not-a-cursor')).toBeUndefined();
    expect(decodeMessageCursor('not-a-date|123e4567-e89b-42d3-a456-426614174000')).toBeUndefined();
    expect(decodeMessageCursor('2026-07-17T18:00:00.123Z|not-a-uuid')).toBeUndefined();
  });
});

describe('direct chat task leases (integration)', () => {
  it('creates a real running lease that the due-task sweeper cannot reclaim', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const agent = await getAgent(db);
    const conversation = await ensureChatConversation(db, agent.id);
    const task = await createChatTask(db, {
      agentId: agent.id,
      conversationId: conversation.id,
    });

    expect(task.status).toBe('running');
    expect(task.lockedUntil).toBeInstanceOf(Date);
    expect((task.lockedUntil as Date).getTime()).toBeGreaterThan(Date.now());
    const due = await findDueTasks(db, 100);
    expect(due.some((candidate) => candidate.id === task.id)).toBe(false);

    await db.delete(tasks).where(eq(tasks.id, task.id));
    await db.delete(conversations).where(eq(conversations.id, conversation.id));
  });

  it('does not let a stale stream persist a reply or overwrite cancellation', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const agent = await getAgent(db);
    const conversation = await ensureChatConversation(db, agent.id);
    const task = await createChatTask(db, {
      agentId: agent.id,
      conversationId: conversation.id,
    });

    expect(await completeTask(db, task.id, { status: 'cancelled' })).toBe(true);
    expect(
      await finishTask(db, task, {
        status: 'done',
        responseText: 'late streamed reply',
      }),
    ).toBe(false);

    const [storedTask] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    const storedReplies = await db.select().from(messages).where(eq(messages.taskId, task.id));
    expect(storedTask?.status).toBe('cancelled');
    expect(storedReplies).toHaveLength(0);

    await db.delete(tasks).where(eq(tasks.id, task.id));
    await db.delete(conversations).where(eq(conversations.id, conversation.id));
  });
});
