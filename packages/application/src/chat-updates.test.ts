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
/** A well-formed id that matches no row — hydration must call it 'missing'. */
const MISSING_ID = '11111111-1111-4111-8111-111111111111';

async function newChat(channel: 'chat' | 'sms' = 'chat'): Promise<string> {
  const [chat] = await db
    .insert(conversations)
    .values({ agentId, channel, trust: 'owner', title: 'chat-updates-test' })
    .returning();
  const id = (chat as NonNullable<typeof chat>).id;
  createdChatIds.push(id);
  return id;
}

async function post(
  conversationId: string,
  role: 'user' | 'assistant',
  text: string,
  options: { createdAt?: Date; parts?: unknown[] } = {},
) {
  const [row] = await db
    .insert(messages)
    .values({
      conversationId,
      role,
      origin: role === 'user' ? 'owner' : 'assistant',
      parts: options.parts ?? [{ type: 'text', text }],
      text,
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    })
    .returning();
  return row as NonNullable<typeof row>;
}

/** A moment far enough past a row's timestamp that the cursor may pass it. */
function settled(row: { createdAt: Date }): Date {
  return new Date(row.createdAt.getTime() + 60_000);
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
    // Delivered now; remembered once it is old enough to be safe — see the
    // late-commit suite below for why the cursor lags.
    expect(updates?.nextCursor).toBe(encodeMessageCursor(seen));
    expect(
      (
        await getChatUpdates(db, {
          conversationId,
          cursor: encodeMessageCursor(seen),
          now: settled(posted),
        })
      )?.nextCursor,
    ).toBe(encodeMessageCursor(posted));
  });

  it('advances its cursor so the same message is not delivered twice', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const conversationId = await newChat();
    const seen = await post(conversationId, 'user', 'first');
    const posted = await post(conversationId, 'assistant', 'second');

    const first = await getChatUpdates(db, {
      conversationId,
      cursor: encodeMessageCursor(seen),
      now: settled(posted),
    });
    expect(first?.messages).toHaveLength(1);
    expect(first?.nextCursor).toBe(encodeMessageCursor(posted));

    const second = await getChatUpdates(db, {
      conversationId,
      cursor: first?.nextCursor ?? undefined,
      now: settled(posted),
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

    await expect(getChatUpdates(db, { conversationId: MISSING_ID })).resolves.toBeNull();
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

describe('the cursor lags far enough that a late commit cannot be lost', () => {
  // messages.created_at defaults to Postgres now() — TRANSACTION START time.
  // A transaction that begins early and commits late lands a row BEHIND a
  // cursor the poll has already moved past, and a strict keyset comparison
  // never returns it again: the message exists but only appears on the next
  // page load, in the middle of the log. Timestamps here are explicit so the
  // window is exercised rather than raced.
  const T0 = new Date('2026-08-18T10:00:00.000Z');
  const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

  async function threadWithALateWriter() {
    const conversationId = await newChat();
    const seen = await post(conversationId, 'user', 'what is on today?', { createdAt: at(0) });
    // Committed second, but its transaction started first, so it is stamped
    // first. The poll below runs in the gap between the two commits.
    const fast = await post(conversationId, 'assistant', 'Your 3pm moved to 4pm.', {
      createdAt: at(1),
    });
    return { conversationId, seen, fast };
  }

  it('holds the cursor back while a row is fresh, then still delivers the straggler', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { conversationId, seen, fast } = await threadWithALateWriter();

    const first = await getChatUpdates(db, {
      conversationId,
      cursor: encodeMessageCursor(seen),
      now: at(2),
    });
    expect(first?.messages.map((message) => message.id)).toEqual([fast.id]);
    expect(first?.nextCursor).toBe(encodeMessageCursor(seen));

    const slow = await post(conversationId, 'assistant', 'And the answer you asked for.', {
      createdAt: at(0.5),
    });
    const second = await getChatUpdates(db, {
      conversationId,
      cursor: first?.nextCursor ?? undefined,
      now: at(3),
    });
    expect(second?.messages.map((message) => message.id)).toEqual([slow.id, fast.id]);
  });

  it('would have lost that straggler had the cursor advanced', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // The same thread, polled late enough that the cursor legitimately moves
    // past `fast`. This is the behaviour the lag exists to postpone: once a row
    // is old enough that nothing can still be committing behind it, passing it
    // is safe — and a writer slower than the whole window is out of scope.
    const { conversationId, seen, fast } = await threadWithALateWriter();

    const first = await getChatUpdates(db, {
      conversationId,
      cursor: encodeMessageCursor(seen),
      now: at(60),
    });
    expect(first?.nextCursor).toBe(encodeMessageCursor(fast));

    const slow = await post(conversationId, 'assistant', 'And the answer you asked for.', {
      createdAt: at(0.5),
    });
    const second = await getChatUpdates(db, {
      conversationId,
      cursor: first?.nextCursor ?? undefined,
      now: at(61),
    });
    expect(second?.messages.map((message) => message.id)).not.toContain(slow.id);
  });

  it('never moves the cursor backwards, and never drops it', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const conversationId = await newChat();
    const seen = await post(conversationId, 'user', 'only message');
    const cursor = encodeMessageCursor(seen);
    // Nothing new at all: the poll must come back with the cursor it was given.
    // The client loops immediately on a page it has not finished, so a cursor
    // that could retreat — or vanish — would spin.
    const updates = await getChatUpdates(db, { conversationId, cursor });
    expect(updates?.messages).toEqual([]);
    expect(updates?.nextCursor).toBe(cursor);
  });
});

describe('refreshing decision cards already on screen', () => {
  it('re-reads named rows without counting them as new output', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const conversationId = await newChat();
    const card = await post(conversationId, 'assistant', 'This needs your approval before I act:', {
      parts: [
        { type: 'text', text: 'This needs your approval before I act:' },
        { type: 'approval', approvalId: MISSING_ID, shortCode: 'A19CG', summary: 'Send the email' },
      ],
    });

    const updates = await getChatUpdates(db, {
      conversationId,
      cursor: encodeMessageCursor(card),
      refreshIds: [card.id],
    });
    // The row the caller already has comes back under `refreshed`, hydrated —
    // never under `messages`, which is what tells the client a turn produced an
    // answer.
    expect(updates?.messages).toEqual([]);
    expect(updates?.refreshed.map((message) => message.id)).toEqual([card.id]);
    const parts = (updates?.refreshed[0]?.parts ?? []) as Array<{
      type: string;
      status?: string;
    }>;
    expect(parts.find((part) => part.type === 'approval')?.status).toBe('missing');
  });

  it('ignores ids that are not this conversation’s', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const conversationId = await newChat();
    const elsewhere = await post(await newChat(), 'assistant', 'not yours');
    const updates = await getChatUpdates(db, { conversationId, refreshIds: [elsewhere.id] });
    expect(updates?.refreshed).toEqual([]);
  });
});
