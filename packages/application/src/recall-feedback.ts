import { getAgent } from '@assistant/core/chat';
import { conversations, type Db, messages, recallFeedback } from '@assistant/db';
import { and, eq, gte, sql } from 'drizzle-orm';

export type RecallFeedbackVerdict = 'helpful' | 'not_helpful';

/**
 * Ratings older than this stop describing how recall is doing now. It matches
 * the retention window `purgeStaleRecallMetrics` applies to the counters this
 * sits beside, so the two halves of recall telemetry describe the same period.
 */
export const RECALL_FEEDBACK_WINDOW_DAYS = 90;

export interface RecallFeedbackSummary {
  /** Recalled replies the owner rated inside the window. */
  rated: number;
  helpful: number;
  notHelpful: number;
  lastRatedAt: Date | null;
  windowDays: number;
}

/**
 * What the owner's own verdicts say about recall lately.
 *
 * The thumbs on a recalled reply were written and never read by anything: the
 * owner was being asked to rate recall and every answer went nowhere, which is
 * worse than not asking. `recall_metrics` records whether retrieval *ran* and
 * the health monitor watches it for failures, but nothing measured whether
 * what it returned was any use — and only the owner can say that.
 *
 * Deliberately just counts. The stored row carries no recalled text or source
 * labels by design, so this reports how many verdicts went each way and when
 * the last one landed; it does not score recall, and it cannot say which fact
 * was unhelpful. Reading four numbers back to the owner is the honest use of
 * what they gave.
 */
export async function getRecallFeedbackSummary(
  db: Db,
  agentId: string,
  opts: { windowDays?: number; now?: Date } = {},
): Promise<RecallFeedbackSummary> {
  const windowDays = opts.windowDays ?? RECALL_FEEDBACK_WINDOW_DAYS;
  const since = new Date((opts.now ?? new Date()).getTime() - windowDays * 24 * 60 * 60_000);

  // Conditional aggregates over one scan, the same shape `getMemoryHealth`
  // uses next door — this is one more row on a page that already loads several.
  const [row] = await db
    .select({
      rated: sql<number>`count(*)`,
      helpful: sql<number>`count(*) FILTER (WHERE ${recallFeedback.verdict} = 'helpful')`,
      notHelpful: sql<number>`count(*) FILTER (WHERE ${recallFeedback.verdict} = 'not_helpful')`,
      lastRatedAt: sql<Date | null>`max(${recallFeedback.createdAt})`,
    })
    .from(recallFeedback)
    .where(and(eq(recallFeedback.agentId, agentId), gte(recallFeedback.createdAt, since)));

  return {
    rated: Number(row?.rated ?? 0),
    helpful: Number(row?.helpful ?? 0),
    notHelpful: Number(row?.notHelpful ?? 0),
    lastRatedAt: row?.lastRatedAt ? new Date(row.lastRatedAt) : null,
    windowDays,
  };
}

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
