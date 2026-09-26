import { createHash, randomUUID } from 'node:crypto';
import type {
  EmailIngestRecord,
  EmailSyncRepository,
  EmailSyncState,
  NewEmailIngest,
  Records,
} from '@assistant/persistence';
import { assertPrivacyErasureInactiveInTransaction } from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

/** Contacts are read whole to map addresses to trust; past this the read fails loudly. */
const CONTACT_LIMIT = 5_000;
/** How long one sync may hold the mailbox lock before another instance may take it over. */
const LOCK_MS = 10 * 60_000;
const LOCK_DOC = 'gmail-sync-lock';

function uuidFrom(parts: unknown[]): string {
  const hex = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  const variant = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function bigintOrNull(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return null;
}

/**
 * Gmail sync on Firestore. The mailbox lock is a leased coordination document,
 * the history baseline only ever rises, and thread bindings and ingest rows
 * use stable ids so concurrent instances converge; imported rows are found by
 * query.
 */
export class FirestoreEmailSyncRepository implements EmailSyncRepository {
  readonly kind = 'email-sync-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly agentId: string,
  ) {}

  async mailbox(): Promise<{ agentId: string; email: string }> {
    const agent = await this.store.doc('agents', this.agentId).get();
    const email = agent.exists ? agent.get('email') : null;
    if (typeof email !== 'string' || !email) throw new Error('Gmail sync owner has no email');
    return { agentId: this.agentId, email };
  }

  async contactTrust(): Promise<Array<{ email: string; trust: 'owner' | 'known' }>> {
    const snapshot = await this.store
      .collection('contacts')
      .limit(CONTACT_LIMIT + 1)
      .get();
    if (snapshot.size > CONTACT_LIMIT) throw new Error('Contact scan exceeded bound');
    return snapshot.docs.flatMap((doc) => {
      const trust = doc.get('trust');
      const emails = doc.get('emails');
      if ((trust !== 'owner' && trust !== 'known') || !Array.isArray(emails)) return [];
      return emails
        .filter((email): email is string => typeof email === 'string')
        .map((email) => ({ email: email.toLowerCase(), trust }));
    });
  }

  private state(mailbox: string) {
    return this.store.doc('gmailSyncState', mailbox);
  }

  async syncState(mailbox: string): Promise<EmailSyncState | null> {
    const snapshot = await this.state(mailbox).get();
    if (!snapshot.exists) return null;
    const row = decodeRecord<Records['gmailSyncState']>(snapshot.data());
    return { lastHistoryId: bigintOrNull(row.lastHistoryId), cursor: row.cursor ?? null };
  }

  private async raise(mailbox: string, historyId: bigint, clearCursor: boolean): Promise<void> {
    const ref = this.state(mailbox);
    await this.store.db.runTransaction(async (tx) => {
      const current = await tx.get(ref);
      const previous = current.exists
        ? bigintOrNull(decodeRecord<{ lastHistoryId?: unknown }>(current.data()).lastHistoryId)
        : null;
      const next = previous !== null && previous > historyId ? previous : historyId;
      tx.set(
        ref,
        encodeRecord({
          mailbox,
          lastHistoryId: next,
          ...(clearCursor ? { cursor: {} } : {}),
          updatedAt: this.store.now(),
        }),
        { merge: true },
      );
    });
  }

  raiseBaseline(mailbox: string, historyId: bigint): Promise<void> {
    return this.raise(mailbox, historyId, false);
  }

  async saveCursor(mailbox: string, cursor: unknown): Promise<void> {
    await this.state(mailbox).set(encodeRecord({ cursor, updatedAt: this.store.now() }), {
      merge: true,
    });
  }

  completeDrain(mailbox: string, targetHistoryId: bigint): Promise<void> {
    return this.raise(mailbox, targetHistoryId, true);
  }

  async setWatchExpiration(mailbox: string, expiration: Date): Promise<void> {
    await this.state(mailbox).set(
      encodeRecord({ mailbox, watchExpiration: expiration, updatedAt: this.store.now() }),
      { merge: true },
    );
  }

  async withLock<T>(run: () => Promise<T>): Promise<{ value: T } | null> {
    const ref = this.store.doc('coordination', LOCK_DOC);
    const holder = randomUUID();
    const acquired = await this.store.db.runTransaction(async (tx) => {
      const current = await tx.get(ref);
      const expiresAt = current.exists ? current.get('expiresAt')?.toDate?.() : null;
      if (expiresAt instanceof Date && expiresAt > this.store.now()) return false;
      tx.set(ref, { holder, expiresAt: new Date(this.store.now().getTime() + LOCK_MS) });
      return true;
    });
    if (!acquired) return null;
    try {
      return { value: await run() };
    } finally {
      await this.store.db
        .runTransaction(async (tx) => {
          const current = await tx.get(ref);
          if (current.exists && current.get('holder') === holder) tx.delete(ref);
        })
        .catch((error) => console.error('email-sync: failed to release mailbox lock', error));
    }
  }

  async inboundMessage(
    channelMessageId: string,
  ): Promise<{ conversationId: string; origin: string } | null> {
    const dedupe = await this.store.doc('messageChannelIds', channelMessageId).get();
    const messageId = dedupe.exists ? dedupe.get('messageId') : null;
    const snapshot =
      typeof messageId === 'string'
        ? await this.store.doc('messages', messageId).get()
        : (
            await this.store
              .collection('messages')
              .where('channelMessageId', '==', channelMessageId)
              .limit(1)
              .get()
          ).docs[0];
    if (!snapshot?.exists) return null;
    const conversationId = snapshot.get('conversationId');
    const origin = snapshot.get('origin');
    return typeof conversationId === 'string' && typeof origin === 'string'
      ? { conversationId, origin }
      : null;
  }

  async hasTaskForEvent(externalEventId: string): Promise<boolean> {
    const snapshot = await this.store
      .collection('tasks')
      .where('externalEventId', '==', externalEventId)
      .limit(1)
      .get();
    return !snapshot.empty;
  }

  async conversationForThread(
    agentId: string,
    threadId: string,
    trust: string,
    subject: string,
  ): Promise<string> {
    if (agentId !== this.agentId) throw new Error('Email thread is outside the configured owner');
    const bindingId = `channel-binding:${createHash('sha256')
      .update(JSON.stringify(['email', threadId]))
      .digest('hex')}`;
    const bindingRef = this.store.doc('channelBindings', bindingId);
    const imported = this.store
      .collection('channelBindings')
      .where('channel', '==', 'email')
      .where('externalId', '==', threadId)
      .limit(1);
    return this.store.db.runTransaction(async (tx) => {
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, agentId);
      const [byId, byThread] = await Promise.all([tx.get(bindingRef), tx.get(imported)]);
      const existing = byId.exists ? byId : byThread.docs[0];
      if (existing) {
        const conversationId = existing.get('conversationId');
        if (typeof conversationId !== 'string') throw new Error('Email binding is malformed');
        return conversationId;
      }
      const now = this.store.now();
      const conversation: Records['conversations'] = {
        id: randomUUID(),
        agentId,
        channel: 'email',
        trust,
        title: subject.slice(0, 80) || '(no subject)',
        isPrimary: false,
        metadata: {},
        archivedAt: null,
        modelOverride: null,
        lastReadAt: null,
        createdAt: now,
        updatedAt: now,
      };
      tx.create(
        this.store.doc('conversations', conversation.id),
        encodeRecord({ ...conversation, archived: false }),
      );
      tx.create(
        bindingRef,
        encodeRecord({
          id: bindingId,
          createdAt: now,
          updatedAt: now,
          channel: 'email',
          conversationId: conversation.id,
          externalId: threadId,
        }),
      );
      return conversation.id;
    });
  }

  private ingestQuery(channelMessageId: string) {
    return this.store
      .collection('emailIngest')
      .where('channelMessageId', '==', channelMessageId)
      .limit(1);
  }

  async ingestRecord(channelMessageId: string): Promise<EmailIngestRecord | null> {
    const byId = await this.store
      .doc('emailIngest', uuidFrom(['email-ingest', channelMessageId]))
      .get();
    const snapshot = byId.exists ? byId : (await this.ingestQuery(channelMessageId).get()).docs[0];
    if (!snapshot?.exists) return null;
    const row = decodeRecord<Records['emailIngest']>(snapshot.data());
    if (typeof row.id !== 'string' || documentKey(row.id) !== snapshot.id) return null;
    return {
      id: row.id,
      conversationId: row.conversationId ?? null,
      importance: row.importance,
      category: row.category,
      contentTrust: row.contentTrust,
      triaged: row.triaged === true,
    };
  }

  async recordIngest(input: NewEmailIngest): Promise<string | null> {
    if (input.agentId !== this.agentId)
      throw new Error('Email ingest is outside the configured owner');
    const id = uuidFrom(['email-ingest', input.channelMessageId]);
    const ref = this.store.doc('emailIngest', id);
    return this.store.db.runTransaction(async (tx) => {
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, input.agentId);
      const [byId, bySource] = await Promise.all([
        tx.get(ref),
        tx.get(this.ingestQuery(input.channelMessageId)),
      ]);
      if (byId.exists || !bySource.empty) return null;
      const now = this.store.now();
      const row: Records['emailIngest'] = {
        ...input,
        id,
        createdAt: now,
        updatedAt: now,
        triaged: false,
        extractedAt: null,
      };
      tx.create(ref, encodeRecord(row));
      return id;
    });
  }

  async triagedSince(since: Date): Promise<number> {
    const result = await this.store
      .collection('emailIngest')
      .where('triaged', '==', true)
      .where('createdAt', '>=', since)
      .count()
      .get();
    return result.data().count;
  }

  async markTriaged(ingestId: string, now: Date): Promise<void> {
    await this.store
      .doc('emailIngest', ingestId)
      .update(encodeRecord({ triaged: true, updatedAt: now }));
  }
}
