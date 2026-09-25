import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import { createPostgresRecallFeedbackRepository } from './recall-feedback-repository.js';
import { agents, conversations, messages, recallFeedback } from './schema.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:55432/assistant_test';

describe('PostgreSQL recall feedback', () => {
  const ownerId = randomUUID();
  const foreignOwnerId = randomUUID();
  const conversationId = randomUUID();
  const foreignConversationId = randomUUID();
  const messageIds: string[] = [];
  let db: Db;
  let dbUp = false;

  async function reply(
    input: { role?: 'assistant' | 'user'; conversation?: string; sources?: number } = {},
  ) {
    const sources = input.sources ?? 2;
    const [row] = await db
      .insert(messages)
      .values({
        conversationId: input.conversation ?? conversationId,
        role: input.role ?? 'assistant',
        origin: input.role === 'user' ? 'owner' : 'assistant',
        text: 'recalled reply',
        parts: [
          { type: 'text', text: 'recalled reply' },
          ...(sources > 0
            ? [{ type: 'recall', sources: Array.from({ length: sources }, () => ({})) }]
            : []),
        ],
      })
      .returning({ id: messages.id });
    const id = (row as NonNullable<typeof row>).id;
    messageIds.push(id);
    return id;
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    try {
      await db.select({ id: agents.id }).from(agents).limit(1);
      dbUp = true;
    } catch {
      console.warn('recall-feedback-repository.test: database unreachable — skipping');
      return;
    }
    await db.insert(agents).values(
      [ownerId, foreignOwnerId].map((id) => ({
        id,
        name: 'Recall feedback owner',
        email: `${id}@test.local`,
        workspacePrefix: `tests/${id}`,
      })),
    );
    await db.insert(conversations).values([
      { id: conversationId, agentId: ownerId, channel: 'chat' },
      { id: foreignConversationId, agentId: foreignOwnerId, channel: 'chat' },
    ]);
  });

  afterAll(async () => {
    if (!dbUp) return;
    if (messageIds.length) {
      await db.delete(recallFeedback).where(inArray(recallFeedback.messageId, messageIds));
      await db.delete(messages).where(inArray(messages.id, messageIds));
    }
    await db
      .delete(conversations)
      .where(inArray(conversations.id, [conversationId, foreignConversationId]));
    await db.delete(agents).where(inArray(agents.id, [ownerId, foreignOwnerId]));
  });

  it('keeps one revisable verdict per recalled reply', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const repository = createPostgresRecallFeedbackRepository(db);
    const messageId = await reply({ sources: 3 });
    await expect(repository.record(ownerId, messageId, 'helpful')).resolves.toBe(true);
    await expect(repository.record(ownerId, messageId, 'not_helpful')).resolves.toBe(true);
    const rows = await db
      .select()
      .from(recallFeedback)
      .where(eq(recallFeedback.messageId, messageId));
    expect(rows).toEqual([
      expect.objectContaining({ agentId: ownerId, verdict: 'not_helpful', sourceCount: 3 }),
    ]);
  });

  it('refuses unrecalled, owner-authored, and foreign replies', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const repository = createPostgresRecallFeedbackRepository(db);
    const refused = [
      await reply({ sources: 0 }),
      await reply({ role: 'user' }),
      await reply({ conversation: foreignConversationId }),
      randomUUID(),
    ];
    for (const id of refused)
      await expect(repository.record(ownerId, id, 'helpful')).resolves.toBe(false);
    const rows = await db
      .select()
      .from(recallFeedback)
      .where(inArray(recallFeedback.messageId, refused));
    expect(rows).toEqual([]);
  });
});
