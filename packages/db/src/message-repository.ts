import type { AppendMessageInput, MessageRepository } from '@assistant/persistence';
import { eq, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { conversations, messages } from './schema.js';

export function createPostgresMessageRepository(db: Db): MessageRepository {
  return {
    kind: 'message-repository',
    append: async (input: AppendMessageInput) =>
      db.transaction(async (tx) => {
        // channel_message_id's unique index is partial (WHERE NOT NULL) — the
        // ON CONFLICT arbiter must match its predicate, and only applies when a
        // channel id is present at all (chat messages have none).
        const [row] = input.channelMessageId
          ? await tx
              .insert(messages)
              .values(input)
              .onConflictDoNothing({
                target: messages.channelMessageId,
                where: sql`${messages.channelMessageId} IS NOT NULL`,
              })
              .returning()
          : await tx.insert(messages).values(input).returning();
        await tx
          .update(conversations)
          .set({ updatedAt: sql`now()` })
          .where(eq(conversations.id, input.conversationId));
        return row;
      }),
  };
}
