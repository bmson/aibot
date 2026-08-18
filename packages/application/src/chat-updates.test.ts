import { encodeMessageCursor, getAgent } from '@assistant/core/chat';
import { conversations, createDb, type Db, messages } from '@assistant/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getChatUpdates } from './chat.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

let db: Db;
let dbUp = false;
let agentId = '';
const createdChatIds: string[] = [];

async function newChat(channel: 'chat' | 'sms' = 'chat'): Promise<string> {
  const [chat] = await db
    .insert(conversations)
    .values({ agentId, channel, trust: 'owner', title: 'chat-updates-test' })
    .returning();
  const id = (chat as NonNullable<typeof chat>).id;
  createdChatIds.push(id);
  return id;
}

async function post(conversationId: string, role: 'user' | 'assistant', text: string) {
  const [row] = await db
    .insert(messages)
    .values({
      conversationId,
      role,
      origin: role === 'user' ? 'owner' : 'assistant',
      parts: [{ type: 'text', text }],
      text,
    })
    .returning();
  return row as NonNullable<typeof row>;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    agentId = (await getAgent(db)).id;
    dbUp = true;
  } catch {
    console.warn('chat-updates.test: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp && createdChatIds.length) {
    await db.delete(messages).where(inArray(messages.conversationId, createdChatIds));
    await db.delete(conversations).where(inArray(conversations.id, createdChatIds));
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('getChatUpdates without a task (the idle thread poll)', () => {
  it('returns what the assistant posted on its own after the cursor', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const conversationId = await newChat();
    const seen = await post(conversationId, 'user', 'what is on today?');

    // A scheduled task, a watch firing, or an approval resuming — none of them
    // carry a task id the open page knows about. Before the conversation-level
    // poll these were invisible until the page was loaded again.
    const posted = await post(conversationId, 'assistant', 'Your 3pm moved to 4pm.');

    const updates = await getChatUpdates(db, {
      conversationId,
      cursor: encodeMessageCursor(seen),
    });

    expect(updates).not.toBeNull();
    expect(updates?.messages.map((message) => message.id)).toEqual([posted.id]);
    expect(updates?.taskStatus).toBeNull();
    expect(updates?.activity).toEqual([]);
    expect(updates?.nextCursor).toBe(encodeMessageCursor(posted));
  });

  it('advances its cursor so the same message is not delivered twice', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const conversationId = await newChat();
    const seen = await post(conversationId, 'user', 'first');
    const posted = await post(conversationId, 'assistant', 'second');

    const first = await getChatUpdates(db, {
      conversationId,
      cursor: encodeMessageCursor(seen),
    });
    expect(first?.messages).toHaveLength(1);

    const second = await getChatUpdates(db, {
      conversationId,
      cursor: first?.nextCursor ?? undefined,
    });
    expect(second?.messages).toEqual([]);
    expect(second?.nextCursor).toBe(encodeMessageCursor(posted));
  });

  it('refuses a conversation that is not this agent’s chat', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // The task lookup is what authorised the caller on the task path; without
    // one, an id from the query string must not be enough on its own.
    const smsThread = await newChat('sms');
    await expect(getChatUpdates(db, { conversationId: smsThread })).resolves.toBeNull();

    const missing = '11111111-1111-4111-8111-111111111111';
    await expect(getChatUpdates(db, { conversationId: missing })).resolves.toBeNull();
  });

  it('pages a long backlog rather than returning it all at once', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const conversationId = await newChat();
    const seen = await post(conversationId, 'user', 'start');
    for (let index = 0; index < 4; index += 1) {
      await post(conversationId, 'assistant', `update ${index.toString()}`);
    }

    const page = await getChatUpdates(db, {
      conversationId,
      cursor: encodeMessageCursor(seen),
      pageSize: 2,
    });
    expect(page?.messages).toHaveLength(2);
    expect(page?.hasMore).toBe(true);

    const rest = await getChatUpdates(db, {
      conversationId,
      cursor: page?.nextCursor ?? undefined,
      pageSize: 2,
    });
    expect(rest?.messages).toHaveLength(2);
    expect(rest?.hasMore).toBe(false);
  });
});
