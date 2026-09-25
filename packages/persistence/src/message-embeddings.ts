/** Minimum text length worth a recall embedding; matches the PostgreSQL backfill. */
export const MESSAGE_EMBEDDING_MIN_CHARS = 21;

/** Whether a chat message becomes a recall candidate once embedded. */
export function messageNeedsEmbedding(role: string, text: string): boolean {
  return (role === 'user' || role === 'assistant') && text.length >= MESSAGE_EMBEDDING_MIN_CHARS;
}

/**
 * The sweep's message-embedding backfill. `pending` returns messages that are
 * recall candidates but have no embedding yet. `record` stores one in the
 * adapter's embedding space and reports false when the message changed or was
 * already embedded, so a retried sweep never overwrites newer state.
 */
export interface MessageEmbeddingRepository {
  readonly kind: 'message-embedding-repository';
  pending(limit: number): Promise<Array<{ id: string; text: string }>>;
  record(id: string, text: string, embedding: number[]): Promise<boolean>;
}
