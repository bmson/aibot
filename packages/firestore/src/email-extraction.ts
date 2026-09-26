import { randomUUID } from 'node:crypto';
import type {
  EmailExtractionRepository,
  EmailExtractionRow,
  EmbeddingSpace,
  Records,
} from '@assistant/persistence';
import { resolveFirestoreSubjectContact } from './contact-lookup.js';
import { FirestoreMemoryRepository } from './memory.js';
import { FirestoreOccasionToolRepository } from './occasion-tools.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

/**
 * `email.extract` on Firestore. Facts are saved through the memory writer, so
 * they carry the installation's embedding space and its content-hash and
 * tombstone markers; occasions go through the occasion tool writer, quarantined.
 */
export class FirestoreEmailExtractionRepository implements EmailExtractionRepository {
  readonly kind = 'email-extraction-repository' as const;
  private readonly memories: FirestoreMemoryRepository;
  private readonly occasions: FirestoreOccasionToolRepository;

  constructor(
    readonly store: InstallationStore,
    readonly agentId: string,
    space: EmbeddingSpace,
  ) {
    this.memories = new FirestoreMemoryRepository(store, space);
    this.occasions = new FirestoreOccasionToolRepository(store, agentId);
  }

  async pending(limit: number): Promise<EmailExtractionRow[]> {
    const snapshot = await this.store
      .collection('emailIngest')
      .where('agentId', '==', this.agentId)
      .where('extractedAt', '==', null)
      .orderBy('createdAt', 'asc')
      .limit(limit)
      .get();
    return snapshot.docs.flatMap((doc) => {
      const row = decodeRecord<Records['emailIngest']>(doc.data());
      if (
        typeof row.id !== 'string' ||
        documentKey(row.id) !== doc.id ||
        row.agentId !== this.agentId
      )
        return [];
      return [
        {
          id: row.id,
          agentId: row.agentId,
          channelMessageId: row.channelMessageId,
          fromEmail: row.fromEmail,
          subject: row.subject,
          category: row.category,
          importance: Number(row.importance) || 0,
        },
      ];
    });
  }

  async messageText(channelMessageId: string): Promise<string | null> {
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
    const text = snapshot?.exists ? snapshot.get('text') : null;
    return typeof text === 'string' ? text : null;
  }

  async stamp(id: string, now: Date): Promise<void> {
    await this.store
      .doc('emailIngest', id)
      .update(encodeRecord({ extractedAt: now, updatedAt: now }));
  }

  async saveFact(input: Parameters<EmailExtractionRepository['saveFact']>[0]) {
    if (input.agentId !== this.agentId)
      throw new Error('Email extraction is outside the configured owner');
    const { fact } = input;
    if ((await this.store.doc('memoryTombstones', fact.contentHash).get()).exists)
      return 'tombstoned' as const;
    const subjectContactId = await resolveFirestoreSubjectContact(
      this.store,
      input.agentId,
      fact.subject,
      fact.relationship,
    );
    const now = this.store.now();
    const memory: Records['memories'] = {
      id: randomUUID(),
      createdAt: now,
      agentId: input.agentId,
      expiresAt: fact.expiresAt,
      embedding: fact.embedding,
      sourceTaskId: input.taskId ?? null,
      kind: fact.kind,
      confidence: fact.confidence,
      contentHash: fact.contentHash,
      goalId: null,
      originTrust: 'unknown',
      category: fact.category,
      content: fact.content,
      importance: fact.importance,
      quarantined: input.quarantined,
      subjectContactId,
      domain: fact.domain,
      validFrom: fact.validFrom,
      validUntil: null,
      supersededById: null,
      ownerConfirmed: false,
      pinned: false,
      source: 'email-ingest',
      lastAccessedAt: null,
      lastConsolidatedAt: null,
    };
    return (await this.memories.save(memory)) ? ('saved' as const) : ('duplicate' as const);
  }

  async saveOccasion(input: Parameters<EmailExtractionRepository['saveOccasion']>[0]) {
    const result = await this.occasions.save({
      agentId: input.agentId,
      subject: input.subject,
      kind: input.kind,
      label: input.label,
      month: input.month,
      day: input.day,
      year: input.year,
      leadDays: 7,
      notes: input.notes,
      originTrust: 'unknown',
      quarantined: true,
      source: 'email-ingest',
    });
    return result ? result.saved : null;
  }

  async pendingCount(): Promise<number> {
    const result = await this.store
      .collection('emailIngest')
      .where('agentId', '==', this.agentId)
      .where('extractedAt', '==', null)
      .count()
      .get();
    return result.data().count;
  }
}
