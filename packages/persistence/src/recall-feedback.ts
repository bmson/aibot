export type RecallFeedbackVerdict = 'helpful' | 'not_helpful';

/**
 * Number of recall sources shown on an assistant message, or 0 when the reply
 * used no recall. Only recalled replies can be rated, and the stored count is
 * the only trace of what was recalled: no text or labels are kept.
 */
export function recallFeedbackSourceCount(parts: unknown): number {
  if (!Array.isArray(parts)) return 0;
  const recall = parts.find(
    (part): part is { type?: unknown; sources?: unknown } =>
      Boolean(part) && typeof part === 'object' && (part as { type?: unknown }).type === 'recall',
  );
  return Array.isArray(recall?.sources) ? recall.sources.length : 0;
}

export interface RecallFeedbackRepository {
  readonly kind: 'recall-feedback-repository';
  /**
   * Record or revise the owner's single verdict for one of their recalled
   * assistant replies. Returns false when the message is missing, belongs to
   * another owner, or is not a reply that used recall.
   */
  record(agentId: string, messageId: string, verdict: RecallFeedbackVerdict): Promise<boolean>;
}
