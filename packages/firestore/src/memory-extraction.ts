import { createHash, randomUUID } from 'node:crypto';
import {
  type CodeJobLease,
  type CommitmentExtractionApplied,
  type EmbeddingSpace,
  type ExtractionConversation,
  type ExtractionMessage,
  type MemoryExtractionApplied,
  type MemoryExtractionRepository,
  type Records,
  validateEmbedding,
} from '@assistant/persistence';
import type {
  DocumentReference,
  QueryDocumentSnapshot,
  Transaction,
} from '@google-cloud/firestore';
import {
  assertCodeJobLeaseInTransaction,
  codeJobCheckpointKeys,
  codeJobCheckpointRef,
  readCodeJobSteps,
  recordCodeJobStep,
} from './code-job-checkpoints.js';
import { contactNameRef, matchSubjectContact, stageNewContact } from './contact-lookup.js';
import { memoryDocument } from './memory.js';
import { occasionDocumentId } from './memory-consolidation.js';
import {
  assertPrivacyErasureFenceUnchanged,
  assertPrivacyErasureInactiveInTransaction,
  readPrivacyErasureFence,
} from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

const JOB = 'memory.extract';
const PAGE = 200;
/**
 * Messages read while looking for the most recently active conversations. The
 * scan runs newest first, so stopping here still yields the most recent
 * conversations; it only shortens the list on an extraordinarily busy day.
 */
const ACTIVITY_SCAN_LIMIT = 5000;
/** Contacts are the attribution vocabulary; beyond this the read fails loudly. */
const CONTACT_LIMIT = 5000;
/** Occasions one person can hold before an upsert refuses to guess. */
const OCCASIONS_PER_CONTACT_LIMIT = 100;
/** Active loops sharing one content hash; more means the fence is broken. */
const HASH_TWIN_LIMIT = 10;
const ACTIVE_STATUSES = ['open', 'snoozed'];

type Contact = Records['contacts'];
type Occasion = Records['occasions'];
type Commitment = Records['commitments'];
type SubjectMatch = ReturnType<typeof matchSubjectContact>;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function commitmentHash(kind: string, title: string, details: string): string {
  return sha256(`${kind}\n${title.trim().toLowerCase()}\n${details.trim().toLowerCase()}`);
}

/** Storage for `memory.extract` on Firestore. Model calls stay in core. */
export class FirestoreMemoryExtractionRepository implements MemoryExtractionRepository {
  readonly kind = 'memory-extraction-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly space: EmbeddingSpace,
  ) {}

  private async owner(agentId: string): Promise<void> {
    if (!agentId) throw new Error('Memory extraction requires an agent');
    const owner = await this.store.doc('agents', agentId).get();
    if (!owner.exists || owner.get('id') !== agentId || documentKey(agentId) !== owner.id)
      throw new Error('Memory extraction agent is missing');
  }

  private async contacts(): Promise<Contact[]> {
    const page = await this.store
      .collection('contacts')
      .limit(CONTACT_LIMIT + 1)
      .get();
    if (page.size > CONTACT_LIMIT) throw new Error('Contact list exceeds the extraction bound');
    return page.docs.map((doc) => decodeRecord<Contact>(doc.data()));
  }

  /** Read the checkpoint and fences, returning the committed keys. */
  private async begin(tx: Transaction, agentId: string, lease: CodeJobLease): Promise<string[]> {
    await assertPrivacyErasureInactiveInTransaction(tx, this.store, agentId);
    await assertCodeJobLeaseInTransaction(tx, this.store, agentId, lease);
    return codeJobCheckpointKeys(
      await tx.get(codeJobCheckpointRef(this.store, lease.taskId)),
      agentId,
      lease.taskId,
    );
  }

  async recentConversations(input: {
    agentId: string;
    since: Date;
    maxConversations: number;
    maxMessages: number;
    minTextLength: number;
  }): Promise<ExtractionConversation[]> {
    if (
      !Number.isInteger(input.maxConversations) ||
      input.maxConversations < 1 ||
      input.maxConversations > 50 ||
      !Number.isInteger(input.maxMessages) ||
      input.maxMessages < 1 ||
      input.maxMessages > 200 ||
      !Number.isFinite(input.since.getTime())
    )
      throw new Error('Invalid extraction window');
    await this.owner(input.agentId);
    const fence = await readPrivacyErasureFence(this.store, input.agentId);
    const qualifies = (row: Records['messages']) =>
      (row.role === 'user' || row.role === 'assistant') &&
      typeof row.text === 'string' &&
      row.text.length >= input.minTextLength;

    // Most recently active first: walk messages newest first and keep each
    // owned conversation the first time one of its messages qualifies.
    const selected: Records['conversations'][] = [];
    const decided = new Set<string>();
    let scanned = 0;
    let cursor: QueryDocumentSnapshot | undefined;
    while (selected.length < input.maxConversations && scanned < ACTIVITY_SCAN_LIMIT) {
      let query = this.store
        .collection('messages')
        .where('createdAt', '>=', input.since)
        .orderBy('createdAt', 'desc')
        .limit(PAGE);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      scanned += page.size;
      const order: string[] = [];
      for (const doc of page.docs) {
        const row = decodeRecord<Records['messages']>(doc.data());
        if (!qualifies(row) || decided.has(row.conversationId)) continue;
        decided.add(row.conversationId);
        order.push(row.conversationId);
      }
      const conversations = order.length
        ? await this.store.db.getAll(...order.map((id) => this.store.doc('conversations', id)))
        : [];
      for (const snapshot of conversations) {
        if (!snapshot.exists || selected.length >= input.maxConversations) continue;
        const row = decodeRecord<Records['conversations']>(snapshot.data());
        if (row.agentId === input.agentId && documentKey(row.id) === snapshot.id)
          selected.push(row);
      }
      if (page.size < PAGE) break;
      cursor = page.docs.at(-1);
    }

    const result: ExtractionConversation[] = [];
    for (const conversation of selected) {
      const messages: ExtractionMessage[] = [];
      let read = 0;
      let after: QueryDocumentSnapshot | undefined;
      // Newest first, skipping short lines, until the transcript is full. The
      // read is capped so a thread of one-word replies cannot turn into a scan.
      while (messages.length < input.maxMessages && read < input.maxMessages * 4) {
        let query = this.store
          .collection('messages')
          .where('conversationId', '==', conversation.id)
          .where('role', 'in', ['user', 'assistant'])
          .where('createdAt', '>=', input.since)
          .orderBy('createdAt', 'desc')
          .orderBy('id', 'desc')
          .limit(input.maxMessages);
        if (after) query = query.startAfter(after);
        const page = await query.get();
        read += page.size;
        for (const doc of page.docs) {
          const row = decodeRecord<Records['messages']>(doc.data());
          if (row.conversationId !== conversation.id || !qualifies(row)) continue;
          if (messages.length < input.maxMessages)
            messages.push({
              id: row.id,
              role: row.role as ExtractionMessage['role'],
              text: row.text,
              createdAt: row.createdAt,
            });
        }
        if (page.size < input.maxMessages) break;
        after = page.docs.at(-1);
      }
      result.push({
        conversationId: conversation.id,
        trust: conversation.trust,
        messages: messages.reverse(),
      });
    }
    await assertPrivacyErasureFenceUnchanged(this.store, input.agentId, fence);
    return result;
  }

  async knownContactNames(agentId: string): Promise<string[]> {
    await this.owner(agentId);
    return (await this.contacts()).map((row) => row.name);
  }

  async completedSteps(agentId: string, lease: CodeJobLease): Promise<string[]> {
    return readCodeJobSteps(this.store, agentId, lease.taskId);
  }

  async applyMemories(
    input: Parameters<MemoryExtractionRepository['applyMemories']>[0],
  ): Promise<MemoryExtractionApplied | null> {
    if (!input.checkpointKey || input.facts.length > 25 || input.occasions.length > 10)
      throw new Error('Invalid memory extraction batch');
    for (const fact of input.facts) {
      if (!fact.content || fact.contentHash !== sha256(fact.content))
        throw new Error('Invalid extracted memory content hash');
      validateEmbedding(this.space, fact.embedding);
    }
    await this.owner(input.agentId);
    // Attribution is decided against the contact list outside the transaction,
    // as the memory tool does; new names converge through their marker below.
    const contacts = await this.contacts();
    const factMatches = input.facts.map((fact) => matchSubjectContact(contacts, fact.subject));
    const occasionMatches = input.occasions.map((occasion) =>
      matchSubjectContact(contacts, occasion.subject),
    );
    const hashes = [...new Set(input.facts.map((fact) => fact.contentHash))];

    return this.store.db.runTransaction(async (tx) => {
      const keys = await this.begin(tx, input.agentId, input.lease);
      if (keys.includes(input.checkpointKey)) return null;

      const hashChecks = hashes.length
        ? await tx.getAll(
            ...hashes.flatMap((hash) => [
              this.store.doc('memoryContentHashes', hash),
              this.store.doc('memoryTombstones', hash),
            ]),
          )
        : [];
      const existingHash = new Set<string>();
      const tombstoned = new Set<string>();
      hashes.forEach((hash, index) => {
        if (hashChecks[index * 2]?.exists) existingHash.add(hash);
        if (hashChecks[index * 2 + 1]?.exists) tombstoned.add(hash);
      });

      // A tombstoned fact names nobody: PostgreSQL checks the tombstone before
      // it resolves (and possibly creates) the fact's subject.
      const newNames = new Map<string, { name: string; relationship?: string }>();
      const want = (match: SubjectMatch, relationship?: string) => {
        if (!match || !('create' in match)) return;
        const key = match.create.toLowerCase();
        if (!newNames.has(key)) newNames.set(key, { name: match.create, relationship });
      };
      input.facts.forEach((fact, index) => {
        if (!tombstoned.has(fact.contentHash)) want(factMatches[index] ?? null, fact.relationship);
      });
      for (const match of occasionMatches) want(match);
      const names = [...newNames.entries()];
      const markers = names.length
        ? await tx.getAll(...names.map(([, entry]) => contactNameRef(this.store, entry.name)))
        : [];
      const marked = new Map<string, string>();
      names.forEach(([key], index) => {
        const marker = markers[index];
        if (marker?.exists) marked.set(key, String(marker.get('contactId')));
      });

      // Existing occasions of every already known person an occasion names.
      const occasionContacts = new Set<string>();
      for (const match of occasionMatches) {
        if (match && 'contactId' in match) occasionContacts.add(match.contactId);
        const markedId = match && 'create' in match ? marked.get(match.create.toLowerCase()) : null;
        if (markedId) occasionContacts.add(markedId);
      }
      const occasionsByContact = new Map<string, QueryDocumentSnapshot[]>();
      for (const contactId of occasionContacts) {
        const page = await tx.get(
          this.store
            .collection('occasions')
            .where('agentId', '==', input.agentId)
            .where('contactId', '==', contactId)
            .limit(OCCASIONS_PER_CONTACT_LIMIT + 1),
        );
        if (page.size > OCCASIONS_PER_CONTACT_LIMIT)
          throw new Error('Occasions for one person exceed the extraction bound');
        occasionsByContact.set(contactId, page.docs);
      }

      // Every read is done; stage the writes.
      const now = this.store.now();
      const result: MemoryExtractionApplied = {
        saved: 0,
        quarantined: 0,
        duplicates: 0,
        tombstoned: 0,
        contactsCreated: 0,
        occasionsSaved: 0,
      };
      const contactIdFor = (match: SubjectMatch): string | null => {
        if (!match) return null;
        if ('contactId' in match) return match.contactId;
        const key = match.create.toLowerCase();
        const known = marked.get(key);
        if (known) return known;
        const id = stageNewContact(tx, this.store, {
          name: match.create,
          relationship: newNames.get(key)?.relationship,
          now,
        });
        marked.set(key, id);
        occasionsByContact.set(id, []);
        result.contactsCreated += 1;
        return id;
      };

      const written = new Set<string>();
      input.facts.forEach((fact, index) => {
        if (tombstoned.has(fact.contentHash)) {
          result.tombstoned += 1;
          return;
        }
        const subjectContactId = contactIdFor(factMatches[index] ?? null);
        if (existingHash.has(fact.contentHash) || written.has(fact.contentHash)) {
          result.duplicates += 1;
          return;
        }
        written.add(fact.contentHash);
        const id = randomUUID();
        const memory: Records['memories'] = {
          id,
          createdAt: now,
          agentId: input.agentId,
          expiresAt: fact.expiresAt,
          embedding: fact.embedding,
          sourceTaskId: input.lease.taskId,
          kind: fact.kind,
          confidence: fact.confidence,
          contentHash: fact.contentHash,
          goalId: null,
          originTrust: input.originTrust,
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
          source: input.source ?? 'extraction',
          lastAccessedAt: null,
          lastConsolidatedAt: null,
        };
        tx.create(this.store.doc('memories', id), memoryDocument(this.space, memory));
        tx.create(this.store.doc('memoryContentHashes', fact.contentHash), { memoryId: id });
        result.saved += 1;
        if (input.quarantined) result.quarantined += 1;
      });

      // The PostgreSQL upsert on (owner, person, kind, month, day): fill an
      // unknown year and append new notes, never downgrading trust or
      // re-quarantining an occasion that was already reviewed.
      const staged = new Map<string, { ref: DocumentReference; row: Occasion; isNew: boolean }>();
      input.occasions.forEach((occasion, index) => {
        const contactId = contactIdFor(occasionMatches[index] ?? null);
        if (
          !contactId ||
          !Number.isInteger(occasion.month) ||
          occasion.month < 1 ||
          occasion.month > 12 ||
          !Number.isInteger(occasion.day) ||
          occasion.day < 1 ||
          occasion.day > 31
        )
          return;
        const notes = occasion.notes.trim().slice(0, 2000);
        const identity = [contactId, occasion.kind, occasion.month, occasion.day].join('\u0000');
        let entry = staged.get(identity);
        if (!entry) {
          const existing = occasionsByContact
            .get(contactId)
            ?.find(
              (doc) =>
                doc.get('agentId') === input.agentId &&
                doc.get('kind') === occasion.kind &&
                doc.get('month') === occasion.month &&
                doc.get('day') === occasion.day,
            );
          if (existing) {
            entry = {
              ref: existing.ref,
              row: decodeRecord<Occasion>(existing.data()),
              isNew: false,
            };
          } else {
            const id = occasionDocumentId(input.agentId, contactId, occasion);
            entry = {
              ref: this.store.doc('occasions', id),
              isNew: true,
              row: {
                id,
                agentId: input.agentId,
                contactId,
                kind: occasion.kind,
                label: occasion.label.slice(0, 120),
                month: occasion.month,
                day: occasion.day,
                year: occasion.year,
                recurrence: 'annual',
                leadDays: 7,
                notes,
                originTrust: input.originTrust,
                quarantined: input.quarantined,
                ownerConfirmed: false,
                source: 'extraction',
                createdAt: now,
                updatedAt: now,
              },
            };
            staged.set(identity, entry);
            result.occasionsSaved += 1;
            return;
          }
          staged.set(identity, entry);
        }
        const current = entry.row;
        entry.row = {
          ...current,
          year: current.year ?? occasion.year,
          notes:
            current.notes === ''
              ? notes
              : notes === '' || current.notes.includes(notes)
                ? current.notes
                : `${current.notes}; ${notes}`,
          updatedAt: now,
        };
      });
      for (const entry of staged.values()) {
        if (entry.isNew) tx.create(entry.ref, encodeRecord(entry.row));
        else
          tx.update(
            entry.ref,
            encodeRecord({ year: entry.row.year, notes: entry.row.notes, updatedAt: now }),
          );
      }

      recordCodeJobStep(tx, this.store, {
        agentId: input.agentId,
        taskId: input.lease.taskId,
        job: JOB,
        keys,
        key: input.checkpointKey,
        now,
      });
      return result;
    });
  }

  async activeCommitments(
    agentId: string,
    limit: number,
  ): Promise<Array<{ id: string; title: string }>> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new Error('Invalid active commitment limit');
    await this.owner(agentId);
    const page = await this.store
      .collection('commitments')
      .where('agentId', '==', agentId)
      .where('status', 'in', ACTIVE_STATUSES)
      .orderBy('updatedAt', 'desc')
      .limit(limit)
      .get();
    return page.docs.flatMap((doc) => {
      const row = decodeRecord<Commitment>(doc.data());
      return row.agentId === agentId && documentKey(row.id) === doc.id
        ? [{ id: row.id, title: row.title }]
        : [];
    });
  }

  async applyCommitments(
    input: Parameters<MemoryExtractionRepository['applyCommitments']>[0],
  ): Promise<CommitmentExtractionApplied | null> {
    if (!input.checkpointKey || input.commitments.length > 12 || input.resolveIds.length > 12)
      throw new Error('Invalid commitment extraction batch');
    for (const item of input.commitments) {
      if (item.contentHash !== commitmentHash(item.kind, item.title, item.details))
        throw new Error('Invalid extracted commitment content hash');
    }
    await this.owner(input.agentId);
    const hashes = [...new Set(input.commitments.map((item) => item.contentHash))];

    return this.store.db.runTransaction(async (tx) => {
      const keys = await this.begin(tx, input.agentId, input.lease);
      if (keys.includes(input.checkpointKey)) return null;
      const conversation = await tx.get(this.store.doc('conversations', input.conversationId));
      if (
        !conversation.exists ||
        conversation.get('agentId') !== input.agentId ||
        conversation.get('trust') !== 'owner'
      )
        throw new Error('Commitment extraction conversation is not an owner thread');

      const resolveDocs = input.resolveIds.length
        ? await tx.getAll(...input.resolveIds.map((id) => this.store.doc('commitments', id)))
        : [];
      const twins = new Map<string, QueryDocumentSnapshot[]>();
      for (const hash of hashes) {
        const page = await tx.get(
          this.store
            .collection('commitments')
            .where('agentId', '==', input.agentId)
            .where('contentHash', '==', hash)
            .limit(HASH_TWIN_LIMIT + 1),
        );
        if (page.size > HASH_TWIN_LIMIT)
          throw new Error('Commitments sharing one content hash exceed the extraction bound');
        twins.set(
          hash,
          page.docs.filter((doc) => ACTIVE_STATUSES.includes(String(doc.get('status')))),
        );
      }

      const now = this.store.now();
      const result: CommitmentExtractionApplied = { saved: 0, duplicates: 0, resolved: 0 };
      const resolvedIds = new Set<string>();
      for (const snapshot of resolveDocs) {
        if (!snapshot.exists) continue;
        const row = decodeRecord<Commitment>(snapshot.data());
        if (
          row.agentId !== input.agentId ||
          documentKey(row.id) !== snapshot.id ||
          !ACTIVE_STATUSES.includes(row.status)
        )
          continue;
        tx.update(snapshot.ref, {
          status: 'resolved',
          resolvedAt: now,
          snoozedUntil: null,
          resolution: input.resolution,
          updatedAt: now,
        });
        resolvedIds.add(row.id);
        result.resolved += 1;
      }

      const refreshed = new Map<string, Record<string, unknown>>();
      const inserted = new Set<string>();
      for (const item of input.commitments) {
        const active = (twins.get(item.contentHash) ?? []).filter(
          (doc) => !resolvedIds.has(String(doc.get('id'))),
        );
        const refresh = {
          conversationId: input.conversationId,
          sourceMessageId: input.sourceMessageId,
          sourceTaskId: input.lease.taskId,
          nextAction: item.nextAction,
          dueAt: item.dueAt,
          confidence: item.confidence,
        };
        if (active.length || inserted.has(item.contentHash)) {
          result.duplicates += 1;
          // Deliberately no updatedAt: noticing a loop again is not the owner
          // touching it, and bumping the clock would keep it from going stale.
          for (const doc of active) refreshed.set(doc.id, refresh);
          continue;
        }
        const id = randomUUID();
        const row: Commitment = {
          id,
          createdAt: now,
          updatedAt: now,
          agentId: input.agentId,
          title: item.title,
          status: 'open',
          kind: item.kind,
          details: item.details,
          snoozedUntil: null,
          resolvedAt: null,
          resolution: null,
          contentHash: item.contentHash,
          ...refresh,
        };
        tx.create(this.store.doc('commitments', id), encodeRecord(row));
        inserted.add(item.contentHash);
        result.saved += 1;
      }
      for (const [docId, refresh] of refreshed)
        tx.update(this.store.collection('commitments').doc(docId), encodeRecord(refresh));

      recordCodeJobStep(tx, this.store, {
        agentId: input.agentId,
        taskId: input.lease.taskId,
        job: JOB,
        keys,
        key: input.checkpointKey,
        now,
      });
      return result;
    });
  }
}
