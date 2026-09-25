import {
  type EmbeddingSpace,
  type MessageEmbeddingRepository,
  messageNeedsEmbedding,
  validateEmbedding,
} from '@assistant/persistence';
import { FieldValue } from '@google-cloud/firestore';
import { embeddingSpaceKey } from './memory.js';
import type { InstallationStore } from './store.js';

/**
 * Marker fields for a message written without an embedding. Firestore cannot
 * query for a missing vector, so writers flag recall candidates and the
 * backfill clears the flag once the vector is stored.
 */
export function messageEmbeddingMarker(role: string, text: string): { embeddingPending?: true } {
  return messageNeedsEmbedding(role, text) ? { embeddingPending: true } : {};
}

/** Embeds new chat messages into the installation's configured embedding space. */
export class FirestoreMessageEmbeddingRepository implements MessageEmbeddingRepository {
  readonly kind = 'message-embedding-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly space: EmbeddingSpace,
  ) {}

  async pending(limit: number): Promise<Array<{ id: string; text: string }>> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new Error('Invalid message embedding batch');
    const snapshot = await this.store
      .collection('messages')
      .where('embeddingPending', '==', true)
      .limit(limit)
      .get();
    return snapshot.docs.map((doc) => ({
      id: String(doc.get('id')),
      text: String(doc.get('text') ?? ''),
    }));
  }

  async record(id: string, text: string, embedding: number[]): Promise<boolean> {
    validateEmbedding(this.space, embedding);
    const ref = this.store.doc('messages', id);
    return this.store.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists || snapshot.get('embeddingPending') !== true) return false;
      // Edited since it was read: leave it pending so the next pass embeds the
      // current text rather than indexing stale wording.
      if (snapshot.get('text') !== text) return false;
      tx.update(ref, {
        embedding: FieldValue.vector(embedding),
        embeddingSpace: embeddingSpaceKey(this.space),
        embeddingPending: FieldValue.delete(),
      });
      return true;
    });
  }
}
