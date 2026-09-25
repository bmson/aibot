import { createHash } from 'node:crypto';
import {
  type RecallFeedbackRepository,
  type RecallFeedbackVerdict,
  recallFeedbackSourceCount,
} from '@assistant/persistence';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

/**
 * New verdicts use an ID derived from the message, so two concurrent first
 * ratings collide on create instead of producing two rows. Imported PostgreSQL
 * rows keep their original random IDs and are found by `messageId` first.
 */
function feedbackIdForMessage(messageId: string): string {
  const hex = createHash('sha256').update(`assistant:recall-feedback:${messageId}`).digest('hex');
  const value = `${hex.slice(0, 12)}5${hex.slice(13, 16)}8${hex.slice(17, 32)}`;
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(
    16,
    20,
  )}-${value.slice(20)}`;
}

/** Firestore twin of the PostgreSQL `recall_feedback` upsert keyed by message. */
export class FirestoreRecallFeedbackRepository implements RecallFeedbackRepository {
  readonly kind = 'recall-feedback-repository' as const;

  constructor(readonly store: InstallationStore) {}

  async record(
    agentId: string,
    messageId: string,
    verdict: RecallFeedbackVerdict,
  ): Promise<boolean> {
    if (!agentId) throw new Error('agent is required');
    if (!messageId) return false;
    const messageRef = this.store.doc('messages', messageId);
    const erasureRef = this.store.doc('privacyErasureJobs', agentId);
    return this.store.db.runTransaction(async (tx) => {
      const [message, erasure] = await tx.getAll(messageRef, erasureRef);
      if (erasure?.exists) {
        if (erasure.get('agentId') !== agentId || erasure.get('status') !== 'complete')
          throw new Error('Privacy erasure is in progress');
      }
      if (!message?.exists) return false;
      const row = decodeRecord<{
        id?: unknown;
        conversationId?: unknown;
        role?: unknown;
        parts?: unknown;
      }>(message.data());
      if (row.id !== messageId || typeof row.conversationId !== 'string' || !row.conversationId)
        return false;
      const conversation = await tx.get(this.store.doc('conversations', row.conversationId));
      if (!conversation.exists || conversation.get('agentId') !== agentId) return false;
      const sourceCount = row.role === 'assistant' ? recallFeedbackSourceCount(row.parts) : 0;
      if (sourceCount === 0) return false;

      const existing = await tx.get(
        this.store.collection('recallFeedback').where('messageId', '==', messageId).limit(2),
      );
      if (existing.size > 1) throw new Error('Recall feedback has duplicate message rows');
      const createdAt = this.store.now();
      const current = existing.docs[0];
      if (current) {
        if (
          current.get('agentId') !== agentId ||
          typeof current.get('id') !== 'string' ||
          documentKey(current.get('id')) !== current.id
        )
          throw new Error('Recall feedback row does not belong to this owner');
        tx.update(current.ref, encodeRecord({ verdict, sourceCount, createdAt }));
        return true;
      }
      const id = feedbackIdForMessage(messageId);
      tx.create(
        this.store.doc('recallFeedback', id),
        encodeRecord({ id, agentId, messageId, verdict, sourceCount, createdAt }),
      );
      return true;
    });
  }
}
