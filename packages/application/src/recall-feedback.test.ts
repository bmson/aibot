import { getAgent } from '@assistant/core/chat';
import { conversations, createDb, type Db, messages, recallFeedback } from '@assistant/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordRecallFeedback } from './recall-feedback.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

describe('recordRecallFeedback (integration)', () => {
  let db: Db;
  let dbUp = false;
  let agentId = '';
  const conversationIds: string[] = [];

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    try {
      agentId = (await getAgent(db)).id;
      dbUp = true;
    } catch {
      console.warn('recall-feedback.test: database unreachable — skipping');
    }
  });

  afterAll(async () => {
    if (dbUp && conversationIds.length > 0) {
      await db.delete(messages).where(inArray(messages.conversationId, conversationIds));
      await db.delete(conversations).where(inArray(conversations.id, conversationIds));
    }
    await (db as unknown as { $client?: { end: () => Promise<void> } }).$client?.end?.();
  });

  async function recalledAssistantMessage() {
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner', title: 'recall feedback test' })
      .returning({ id: conversations.id });
    if (!conversation) throw new Error('test conversation was not created');
    conversationIds.push(conversation.id);
    const [message] = await db
      .insert(messages)
      .values({
        conversationId: conversation.id,
        role: 'assistant',
        origin: 'assistant',
        text: 'You asked me to remember this.',
        parts: [
          { type: 'text', text: 'You asked me to remember this.' },
          {
            type: 'recall',
            sources: [
              { date: '2026-08-01', label: 'Conversation', kind: 'chat' },
              { date: '2026-07-15', label: 'Preference', kind: 'knowledge_graph' },
            ],
          },
        ],
      })
      .returning({ id: messages.id });
    if (!message) throw new Error('test message was not created');
    return message.id;
  }

  it('stores only one revisable verdict and its source count', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const messageId = await recalledAssistantMessage();
    await recordRecallFeedback(db, messageId, 'helpful');
    await recordRecallFeedback(db, messageId, 'not_helpful');

    const rows = await db
      .select()
      .from(recallFeedback)
      .where(eq(recallFeedback.messageId, messageId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ verdict: 'not_helpful', sourceCount: 2, agentId });
  });

  it('refuses feedback for an assistant reply without disclosed recall', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner', title: 'plain reply test' })
      .returning({ id: conversations.id });
    if (!conversation) throw new Error('test conversation was not created');
    conversationIds.push(conversation.id);
    const [message] = await db
      .insert(messages)
      .values({
        conversationId: conversation.id,
        role: 'assistant',
        origin: 'assistant',
        text: 'No recalled context here.',
        parts: [{ type: 'text', text: 'No recalled context here.' }],
      })
      .returning({ id: messages.id });
    if (!message) throw new Error('test message was not created');

    await expect(recordRecallFeedback(db, message.id, 'helpful')).rejects.toThrow(
      'Recall feedback is only available for recalled replies.',
    );
  });
});
