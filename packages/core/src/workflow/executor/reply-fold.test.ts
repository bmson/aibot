import { conversations, createDb, type Db, messages, type TaskRow } from '@assistant/db';
import type { ModelMessage } from 'ai';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../../chat.js';
import type { TaskState } from '../../events.js';
import { foldOwnerRepliesSincePark } from './seed.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

describe('foldOwnerRepliesSincePark', () => {
  let db: Db;
  let dbUp = false;
  let agentId: string;
  const conversationIds: string[] = [];

  async function makeConversation(channel: 'chat' | 'email'): Promise<string> {
    const [conv] = await db
      .insert(conversations)
      .values({ agentId, channel, trust: 'owner', title: `xtest-fold-${channel}` })
      .returning({ id: conversations.id });
    const id = (conv as NonNullable<typeof conv>).id;
    conversationIds.push(id);
    return id;
  }

  async function addOwnerMessage(conversationId: string, text: string, at: Date): Promise<void> {
    await db.insert(messages).values({
      conversationId,
      role: 'user',
      origin: 'owner',
      parts: [{ type: 'text', text }],
      text,
      createdAt: at,
    });
  }

  const stateWith = (seenConversationAt?: string): TaskState =>
    ({ seenConversationAt, contextWindow: [] }) as unknown as TaskState;

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    try {
      agentId = (await getAgent(db)).id;
      dbUp = true;
    } catch {
      console.warn('reply-fold.test: database unreachable — skipping');
    }
  });

  afterAll(async () => {
    if (!dbUp) return;
    if (conversationIds.length) {
      await db.delete(messages).where(inArray(messages.conversationId, conversationIds));
      await db.delete(conversations).where(inArray(conversations.id, conversationIds));
    }
  });

  it('baselines the watermark on the first run without folding', async () => {
    if (!dbUp) return;
    const conversationId = await makeConversation('chat');
    await addOwnerMessage(conversationId, 'seed message', new Date('2026-07-22T10:00:00Z'));
    const state = stateWith(undefined);
    const window: ModelMessage[] = [];
    await foldOwnerRepliesSincePark(db, { conversationId } as TaskRow, state, window);
    expect(window).toHaveLength(0); // nothing folded — seed already holds it
    expect(state.seenConversationAt).toBe(new Date('2026-07-22T10:00:00Z').toISOString());
  });

  it('folds an owner reply newer than the watermark and advances it', async () => {
    if (!dbUp) return;
    const conversationId = await makeConversation('chat');
    await addOwnerMessage(conversationId, 'actually make it Bob', new Date('2026-07-22T11:00:00Z'));
    const state = stateWith(new Date('2026-07-22T10:00:00Z').toISOString());
    const window: ModelMessage[] = [];
    await foldOwnerRepliesSincePark(db, { conversationId } as TaskRow, state, window);
    expect(window).toHaveLength(1);
    expect(String(window[0]?.content)).toContain('actually make it Bob');
    expect(String(window[0]?.content)).toContain('while the task was paused');
    expect(state.seenConversationAt).toBe(new Date('2026-07-22T11:00:00Z').toISOString());

    // Idempotent: a second fold with the advanced watermark appends nothing.
    const window2: ModelMessage[] = [];
    await foldOwnerRepliesSincePark(db, { conversationId } as TaskRow, state, window2);
    expect(window2).toHaveLength(0);
  });

  it('never folds email-channel conversations (no third-party reinjection)', async () => {
    if (!dbUp) return;
    const conversationId = await makeConversation('email');
    await addOwnerMessage(conversationId, 'a quoted forward', new Date('2026-07-22T11:00:00Z'));
    const state = stateWith(new Date('2026-07-22T10:00:00Z').toISOString());
    const window: ModelMessage[] = [];
    await foldOwnerRepliesSincePark(db, { conversationId } as TaskRow, state, window);
    expect(window).toHaveLength(0);
    // The watermark is left untouched for a non-chat channel.
    expect(state.seenConversationAt).toBe(new Date('2026-07-22T10:00:00Z').toISOString());
  });
});
