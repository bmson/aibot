import { getAgent } from '@assistant/core/chat';
import { conversations, type Db, messages, recallFeedback } from '@assistant/db';
import { and, eq } from 'drizzle-orm';

export type RecallFeedbackVerdict = 'helpful' | 'not_helpful';

function recallSourceCount(parts: unknown): number {
  if (!Array.isArray(parts)) return 0;
  const recall = parts.find(
    (part): part is { type?: unknown; sources?: unknown } =>
      Boolean(part) && typeof part === 'object' && (part as { type?: unknown }).type === 'recall',
  );
  return Array.isArray(recall?.sources) ? recall.sources.length : 0;
}

/**
 * Records a single, revisable owner verdict for a recalled assistant response.
 * The row intentionally contains no recalled text or source labels: feedback
 * must improve the rollout without becoming a second store of personal data.
 */
export async function recordRecallFeedback(
  db: Db,
  messageId: string,
  verdict: RecallFeedbackVerdict,
): Promise<void> {
  if (verdict !== 'helpful' && verdict !== 'not_helpful')
    throw new Error('Invalid recall feedback.');
  const agent = await getAgent(db);
  const [message] = await db
    .select({ id: messages.id, role: messages.role, parts: messages.parts })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(and(eq(messages.id, messageId), eq(conversations.agentId, agent.id)))
    .limit(1);
  const sourceCount = message?.role === 'assistant' ? recallSourceCount(message.parts) : 0;
  if (!message || sourceCount === 0)
    throw new Error('Recall feedback is only available for recalled replies.');

  await db
    .insert(recallFeedback)
    .values({ agentId: agent.id, messageId, verdict, sourceCount, createdAt: new Date() })
    .onConflictDoUpdate({
      target: recallFeedback.messageId,
      set: { verdict, sourceCount, createdAt: new Date() },
    });
}
