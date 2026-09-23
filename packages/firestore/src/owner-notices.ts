import { randomUUID } from 'node:crypto';
import type { Records } from '@assistant/persistence';
import type { DocumentSnapshot, Transaction } from '@google-cloud/firestore';
import { messageRecord } from './messages.js';
import { privacyErasureIsActive, readPrivacyErasureFence } from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

type Conversation = Records['conversations'];

function ownedConversation(snapshot: DocumentSnapshot, agentId: string): Conversation {
  const row = decodeRecord<Conversation>(snapshot.data());
  if (
    !snapshot.exists ||
    row.agentId !== agentId ||
    documentKey(row.id) !== snapshot.id ||
    row.channel !== 'chat'
  )
    throw new Error('Owner notice conversation identity mismatch');
  return row;
}

/** Durable dashboard sink for background work in a customer-owned installation. */
export class FirestoreOwnerNoticeRepository {
  constructor(
    readonly store: InstallationStore,
    readonly agentId: string,
  ) {}

  private async owner(tx: Transaction): Promise<void> {
    const owners = await tx.get(this.store.collection('agents').limit(2));
    const owner = owners.docs[0];
    if (
      !this.agentId ||
      owners.size !== 1 ||
      !owner ||
      owner.get('id') !== this.agentId ||
      owner.id !== documentKey(this.agentId)
    )
      throw new Error('Owner notices require exactly one configured owner');
  }

  private async primary(tx: Transaction): Promise<Conversation | null> {
    const marker = await tx.get(this.store.doc('primaryConversations', this.agentId));
    if (marker.exists) {
      const id = marker.get('conversationId');
      if (marker.get('agentId') !== this.agentId || typeof id !== 'string' || !id)
        throw new Error('Primary conversation marker is malformed');
      const snapshot = await tx.get(this.store.doc('conversations', id));
      if (!snapshot.exists) throw new Error('Primary conversation marker is stale');
      const row = ownedConversation(snapshot, this.agentId);
      if (!row.isPrimary) throw new Error('Primary conversation marker is stale');
      return row.archivedAt ? null : row;
    }
    // Migrated installations may have a primary chat but no derived marker yet.
    const matches = await tx.get(
      this.store
        .collection('conversations')
        .where('agentId', '==', this.agentId)
        .where('isPrimary', '==', true)
        .limit(2),
    );
    if (matches.size > 1) throw new Error('Ambiguous primary conversation');
    const snapshot = matches.docs[0];
    if (!snapshot) return null;
    const row = ownedConversation(snapshot, this.agentId);
    return row.archivedAt ? null : row;
  }

  async primaryConversationId(): Promise<string | null> {
    const fence = await readPrivacyErasureFence(this.store, this.agentId);
    const result = await this.store.db.runTransaction(async (tx) => {
      await this.owner(tx);
      const primary = await this.primary(tx);
      return primary?.id ?? null;
    });
    const after = await readPrivacyErasureFence(this.store, this.agentId);
    if (fence === null ? after !== null : !after?.isEqual(fence))
      throw new Error('Privacy erasure changed during owner notice read');
    return result;
  }

  private async notifications(tx: Transaction): Promise<{ row: Conversation; created: boolean }> {
    const markerRef = this.store.doc('notificationConversations', this.agentId);
    const marker = await tx.get(markerRef);
    if (marker.exists) {
      const id = marker.get('conversationId');
      if (marker.get('agentId') !== this.agentId || typeof id !== 'string' || !id)
        throw new Error('Notifications conversation marker is malformed');
      const snapshot = await tx.get(this.store.doc('conversations', id));
      if (!snapshot.exists) throw new Error('Notifications conversation marker is stale');
      const row = ownedConversation(snapshot, this.agentId);
      if (row.title !== 'Notifications' || row.isPrimary)
        throw new Error('Notifications conversation marker is stale');
      return { row, created: false };
    }
    const matches = await tx.get(
      this.store
        .collection('conversations')
        .where('agentId', '==', this.agentId)
        .where('title', '==', 'Notifications')
        .limit(2),
    );
    if (matches.size > 1) throw new Error('Ambiguous Notifications conversation');
    const snapshot = matches.docs[0];
    if (snapshot) {
      const row = ownedConversation(snapshot, this.agentId);
      if (row.isPrimary) throw new Error('Notifications conversation is primary');
      tx.create(markerRef, {
        agentId: this.agentId,
        conversationId: row.id,
        createdAt: this.store.now(),
      });
      return { row, created: false };
    }
    const now = this.store.now();
    const row: Conversation = {
      id: randomUUID(),
      agentId: this.agentId,
      channel: 'chat',
      trust: 'assistant',
      title: 'Notifications',
      isPrimary: false,
      metadata: {},
      archivedAt: null,
      modelOverride: null,
      lastReadAt: null,
      createdAt: now,
      updatedAt: now,
    };
    tx.create(markerRef, { agentId: this.agentId, conversationId: row.id, createdAt: now });
    return { row, created: true };
  }

  async post(input: {
    text: string;
    taskId?: string;
    sourceConversationId?: string | null;
    extraParts?: readonly unknown[];
  }): Promise<{ conversationId: string } | null> {
    const fence = await readPrivacyErasureFence(this.store, this.agentId);
    return this.store.db.runTransaction(async (tx) => {
      await this.owner(tx);
      const erasure = await tx.get(this.store.doc('privacyErasureJobs', this.agentId));
      if (erasure.exists) {
        if (
          erasure.get('agentId') !== this.agentId ||
          privacyErasureIsActive(erasure.get('status')) ||
          !erasure.updateTime ||
          !fence?.isEqual(erasure.updateTime)
        )
          throw new Error('Privacy erasure changed during owner notice');
      } else if (fence) {
        throw new Error('Privacy erasure changed during owner notice');
      }
      if (input.taskId) {
        const task = await tx.get(this.store.doc('tasks', input.taskId));
        if (!task.exists || task.get('id') !== input.taskId || task.get('agentId') !== this.agentId)
          throw new Error('Owner notice task is outside the configured installation');
      }
      const primary = await this.primary(tx);
      if (primary && input.sourceConversationId === primary.id) return null;
      const destination = primary ? { row: primary, created: false } : await this.notifications(tx);
      if (input.sourceConversationId === destination.row.id) return null;
      const now = this.store.now();
      const message = messageRecord(
        {
          conversationId: destination.row.id,
          ...(input.taskId ? { taskId: input.taskId } : {}),
          role: 'assistant',
          origin: 'assistant',
          parts: [{ type: 'text', text: input.text }, ...(input.extraParts ?? [])],
          text: input.text,
        },
        randomUUID(),
        now,
      );
      const conversationRef = this.store.doc('conversations', destination.row.id);
      if (destination.created)
        tx.create(
          conversationRef,
          encodeRecord({ ...destination.row, updatedAt: now, archived: false }),
        );
      else
        tx.update(conversationRef, {
          updatedAt: now,
          ...(destination.row.archivedAt ? { archivedAt: null, archived: false } : {}),
        });
      tx.create(this.store.doc('messages', message.id), encodeRecord(message));
      return { conversationId: destination.row.id };
    });
  }
}
