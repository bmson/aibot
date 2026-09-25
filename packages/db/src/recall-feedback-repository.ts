import { type RecallFeedbackRepository, recallFeedbackSourceCount } from '@assistant/persistence';
import { and, eq } from 'drizzle-orm';
import type { Db } from './client.js';
import { conversations, messages, recallFeedback } from './schema.js';

/** Owner-scoped recall verdicts, one revisable row per recalled reply. */
export function createPostgresRecallFeedbackRepository(db: Db): RecallFeedbackRepository {
  return {
    kind: 'recall-feedback-repository',
    async record(agentId, messageId, verdict) {
      const [message] = await db
        .select({ role: messages.role, parts: messages.parts })
        .from(messages)
        .innerJoin(conversations, eq(messages.conversationId, conversations.id))
        .where(and(eq(messages.id, messageId), eq(conversations.agentId, agentId)))
        .limit(1);
      const sourceCount =
        message?.role === 'assistant' ? recallFeedbackSourceCount(message.parts) : 0;
      if (!message || sourceCount === 0) return false;
      const createdAt = new Date();
      await db
        .insert(recallFeedback)
        .values({ agentId, messageId, verdict, sourceCount, createdAt })
        .onConflictDoUpdate({
          target: recallFeedback.messageId,
          set: { verdict, sourceCount, createdAt },
        });
      return true;
    },
  };
}
