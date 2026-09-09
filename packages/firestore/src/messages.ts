import { randomUUID } from 'node:crypto';
import type { AppendMessageInput, MessageRepository, Records } from '@assistant/persistence';
import { encodeRecord, type InstallationStore } from './store.js';

export function messageRecord(
  input: AppendMessageInput,
  id: string,
  now: Date,
): Records['messages'] {
  const row = {
    ...input,
    id,
    createdAt: now,
    taskId: input.taskId ?? null,
    channelMessageId: input.channelMessageId ?? null,
    embedding: null,
  };
  // Leave room for Firestore's field-name/type overhead. Oversize content must go through
  // the forthcoming GCS payload adapter; never silently truncate or split a transaction.
  if (Buffer.byteLength(JSON.stringify(row), 'utf8') > 900_000) {
    throw new Error('Message exceeds inline storage limit; store its payload in Cloud Storage');
  }
  return row;
}

export class FirestoreMessageRepository implements MessageRepository {
  readonly kind = 'message-repository' as const;
  constructor(readonly store: InstallationStore) {}

  async append(input: AppendMessageInput): Promise<Records['messages'] | undefined> {
    const id = randomUUID();
    const conversation = this.store.doc('conversations', input.conversationId);
    const dedupe = input.channelMessageId
      ? this.store.doc('messageChannelIds', input.channelMessageId)
      : null;
    return this.store.db.runTransaction(async (tx) => {
      const parent = await tx.get(conversation);
      if (!parent.exists) throw new Error('Conversation does not exist');
      const existing = dedupe ? await tx.get(dedupe) : null;
      if (existing?.exists) {
        // A provider ID cannot redirect a message into a different conversation.
        if (existing.data()?.conversationId !== input.conversationId) {
          throw new Error('Channel message ID belongs to another conversation');
        }
        return undefined;
      }
      const now = this.store.now();
      const row = messageRecord(input, id, now);
      tx.create(this.store.doc('messages', id), encodeRecord(row));
      if (dedupe) tx.create(dedupe, { messageId: id, conversationId: input.conversationId });
      tx.update(conversation, { updatedAt: now });
      return row;
    });
  }
}
