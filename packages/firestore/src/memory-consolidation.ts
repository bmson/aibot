import { createHash, randomUUID } from 'node:crypto';
import {
  CONSOLIDATION_CANDIDATE_LIMIT,
  CONSOLIDATION_WINDOW_LIMIT,
  type ConsolidationFact,
  type ConsolidationReview,
  type EmbeddingSpace,
  type MemoryConsolidationRepository,
  type Records,
  validateEmbedding,
} from '@assistant/persistence';
import {
  FieldValue,
  Filter,
  type Query,
  type QueryDocumentSnapshot,
} from '@google-cloud/firestore';
import { embeddingSpaceKey } from './memory.js';
import {
  assertPrivacyErasureFenceUnchanged,
  privacyErasureIsActive,
  readPrivacyErasureFence,
} from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

type Memory = Records['memories'];

function version(doc: QueryDocumentSnapshot): string {
  const time = doc.updateTime;
  if (!time) throw new Error('Memory has no version');
  return `${time.seconds}:${time.nanoseconds}`;
}

function active(row: Memory, agentId: string, now: Date): boolean {
  return (
    row.agentId === agentId &&
    row.category === 'knowledge' &&
    !row.quarantined &&
    !row.supersededById &&
    (!row.expiresAt || row.expiresAt > now)
  );
}

function fact(doc: QueryDocumentSnapshot, agentId: string, now: Date): ConsolidationFact | null {
  const row = decodeRecord<Memory>(doc.data());
  if (row.id !== doc.get('id') || documentKey(row.id) !== doc.id || !active(row, agentId, now))
    return null;
  return {
    id: row.id,
    agentId: row.agentId,
    subjectContactId: row.subjectContactId,
    content: row.content,
    kind: row.kind,
    confidence: row.confidence,
    importance: row.importance,
    domain: row.domain,
    ownerConfirmed: row.ownerConfirmed,
    pinned: row.pinned,
    lastConsolidatedAt: row.lastConsolidatedAt,
    createdAt: row.createdAt,
    validFrom: row.validFrom,
    validUntil: row.validUntil,
    version: version(doc),
  };
}

function eligibleQuery(store: InstallationStore, agentId: string): Query {
  const now = store.now();
  return store
    .collection('memories')
    .where('agentId', '==', agentId)
    .where('category', '==', 'knowledge')
    .where('quarantined', '==', false)
    .where('supersededById', '==', null)
    .where(Filter.or(Filter.where('expiresAt', '==', null), Filter.where('expiresAt', '>', now)));
}

function reviewOrder(a: ConsolidationFact, b: ConsolidationFact): number {
  return (
    (a.lastConsolidatedAt?.getTime() ?? -Infinity) -
      (b.lastConsolidatedAt?.getTime() ?? -Infinity) ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    a.id.localeCompare(b.id)
  );
}

/** Storage seam only: model decisions, occasions, card compilation, and dispatch stay in core. */
export class FirestoreMemoryConsolidationRepository implements MemoryConsolidationRepository {
  readonly kind = 'memory-consolidation-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly space: EmbeddingSpace,
  ) {}

  private async owner(agentId: string): Promise<void> {
    if (!agentId) throw new Error('Consolidation requires an agent');
    const owner = await this.store.doc('agents', agentId).get();
    if (!owner.exists || owner.get('id') !== agentId || documentKey(agentId) !== owner.id)
      throw new Error('Consolidation agent is missing');
  }

  async candidates(agentId: string) {
    await this.owner(agentId);
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const now = this.store.now();
    const pending = await eligibleQuery(this.store, agentId)
      .where('lastConsolidatedAt', '==', null)
      .limit(CONSOLIDATION_CANDIDATE_LIMIT)
      .get();
    const standalone: ConsolidationFact[] = [];
    const seen = new Set<string>();
    let window: { subjectContactId: string; facts: ConsolidationFact[] } | null = null;
    for (const doc of pending.docs) {
      const candidate = fact(doc, agentId, now);
      if (!candidate || candidate.lastConsolidatedAt) continue;
      const subject = candidate.subjectContactId;
      if (!subject) {
        standalone.push(candidate);
      } else if (!seen.has(subject)) {
        seen.add(subject);
        const pendingForSubject = await eligibleQuery(this.store, agentId)
          .where('subjectContactId', '==', subject)
          .where('lastConsolidatedAt', '==', null)
          .limit(CONSOLIDATION_WINDOW_LIMIT)
          .get();
        // Explicitly fetch never-reviewed facts first. A person with more than
        // one page of dated facts must still rotate beyond the first page.
        const page =
          pendingForSubject.size < CONSOLIDATION_WINDOW_LIMIT
            ? await eligibleQuery(this.store, agentId)
                .where('subjectContactId', '==', subject)
                .limit(CONSOLIDATION_CANDIDATE_LIMIT)
                .get()
            : null;
        const byId = new Map(
          [...pendingForSubject.docs, ...(page?.docs ?? [])].map((row) => [row.id, row]),
        );
        const facts = [...byId.values()]
          .map((row) => fact(row, agentId, now))
          .filter((row): row is ConsolidationFact => Boolean(row))
          .sort(reviewOrder)
          .slice(0, CONSOLIDATION_WINDOW_LIMIT);
        if (facts.length === 1 && facts[0]?.id === candidate.id) standalone.push(candidate);
        else if (facts.length >= 2 && !window) window = { subjectContactId: subject, facts };
      }
      if (standalone.length >= CONSOLIDATION_WINDOW_LIMIT) break;
    }
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return { standalone, window };
  }

  async stampStandalone(agentId: string, facts: ConsolidationFact[]): Promise<number> {
    if (facts.length > CONSOLIDATION_WINDOW_LIMIT || facts.some((row) => row.agentId !== agentId))
      throw new Error('Invalid standalone consolidation batch');
    if (!facts.length) return 0;
    await this.owner(agentId);
    return this.store.db.runTransaction(async (tx) => {
      const erasure = await tx.get(this.store.doc('privacyErasureJobs', agentId));
      if (erasure.exists && privacyErasureIsActive(erasure.get('status')))
        throw new Error('Privacy erasure is in progress');
      const docs = await tx.getAll(...facts.map((row) => this.store.doc('memories', row.id)));
      const now = this.store.now();
      for (let index = 0; index < docs.length; index++) {
        const doc = docs[index];
        const expected = facts[index];
        if (
          !doc?.exists ||
          !expected ||
          fact(doc as QueryDocumentSnapshot, agentId, now)?.version !== expected.version ||
          doc.get('lastConsolidatedAt') !== null
        )
          throw new Error('Standalone memory changed during consolidation');
      }
      const tombstones = await tx.getAll(
        ...docs.map((doc) => this.store.doc('memoryTombstones', String(doc?.get('contentHash')))),
      );
      if (tombstones.some((row) => row.exists)) throw new Error('Standalone memory was erased');
      // A person may gain a second fact after candidate selection. Recheck before stamping.
      for (const subject of new Set(
        facts.map((row) => row.subjectContactId).filter((id): id is string => Boolean(id)),
      )) {
        const peers = await tx.get(
          eligibleQuery(this.store, agentId).where('subjectContactId', '==', subject).limit(2),
        );
        if (peers.size !== 1) throw new Error('Standalone subject changed during consolidation');
      }
      for (const doc of docs) if (doc) tx.update(doc.ref, { lastConsolidatedAt: now });
      return docs.length;
    });
  }

  async applyReview(input: ConsolidationReview) {
    const { agentId, subjectContactId, facts } = input;
    if (
      !agentId ||
      !subjectContactId ||
      facts.length < 2 ||
      facts.length > CONSOLIDATION_WINDOW_LIMIT ||
      new Set(facts.map((row) => row.id)).size !== facts.length ||
      facts.some((row) => row.agentId !== agentId || row.subjectContactId !== subjectContactId)
    )
      throw new Error('Invalid consolidation review');
    const ids = new Set(facts.map((row) => row.id));
    if (
      input.retirements.some(
        (row) => !ids.has(row.id) || !ids.has(row.supersededById) || row.id === row.supersededById,
      ) ||
      input.domainFixes.some((row) => !ids.has(row.id)) ||
      input.timeline.some((row) => !ids.has(row.id)) ||
      input.merges.some(
        (merge) => merge.memberIds.length < 2 || merge.memberIds.some((id) => !ids.has(id)),
      )
    )
      throw new Error('Consolidation decision references an unknown fact');
    if (
      input.merges.length > 15 ||
      new Set(input.merges.map((merge) => merge.id)).size !== input.merges.length ||
      new Set(input.merges.map((merge) => merge.contentHash)).size !== input.merges.length
    )
      throw new Error('Invalid consolidation merges');
    for (const merge of input.merges) {
      if (
        !merge.content.trim() ||
        merge.contentHash !== createHash('sha256').update(merge.content).digest('hex')
      )
        throw new Error('Invalid consolidation content hash');
      validateEmbedding(this.space, merge.embedding);
    }
    await this.owner(agentId);
    return this.store.db.runTransaction(async (tx) => {
      const erasure = await tx.get(this.store.doc('privacyErasureJobs', agentId));
      if (erasure.exists && privacyErasureIsActive(erasure.get('status')))
        throw new Error('Privacy erasure is in progress');
      const docs = await tx.getAll(...facts.map((row) => this.store.doc('memories', row.id)));
      const now = this.store.now();
      const byId = new Map<string, QueryDocumentSnapshot>();
      for (let index = 0; index < facts.length; index++) {
        const doc = docs[index];
        const expected = facts[index];
        if (
          !doc?.exists ||
          !expected ||
          fact(doc as QueryDocumentSnapshot, agentId, now)?.version !== expected.version ||
          doc.get('subjectContactId') !== subjectContactId
        )
          throw new Error('Consolidation memory changed during review');
        byId.set(expected.id, doc as QueryDocumentSnapshot);
      }
      const tombstones = await tx.getAll(
        ...facts.map((row) =>
          this.store.doc('memoryTombstones', byId.get(row.id)?.get('contentHash')),
        ),
      );
      if (tombstones.some((row) => row.exists)) throw new Error('Consolidation memory was erased');
      const mergeRefs = input.merges.flatMap((merge) => [
        this.store.doc('memories', merge.id),
        this.store.doc('memoryContentHashes', merge.contentHash),
        this.store.doc('memoryTombstones', merge.contentHash),
      ]);
      const mergeChecks = mergeRefs.length ? await tx.getAll(...mergeRefs) : [];
      const retired: string[] = [];
      const merged: string[] = [];
      const domainsAssigned: string[] = [];
      const replacement = new Map(input.retirements.map((row) => [row.id, row.supersededById]));
      for (let index = 0; index < input.merges.length; index++) {
        const merge = input.merges[index];
        if (!merge) continue;
        if (mergeChecks.slice(index * 3, index * 3 + 3).some((row) => row?.exists)) continue;
        if (
          !merge.id ||
          !merge.contentHash ||
          new Set(merge.memberIds).size !== merge.memberIds.length ||
          merge.memberIds.some(
            (id) =>
              replacement.has(id) ||
              byId.get(id)?.get('ownerConfirmed') ||
              byId.get(id)?.get('pinned'),
          )
        )
          throw new Error('Invalid consolidation merge');
        const row: Memory = {
          id: merge.id,
          agentId,
          subjectContactId,
          createdAt: now,
          expiresAt: null,
          embedding: merge.embedding,
          sourceTaskId: merge.sourceTaskId,
          kind: merge.kind,
          confidence: merge.confidence,
          contentHash: merge.contentHash,
          goalId: null,
          originTrust: 'assistant',
          category: 'knowledge',
          content: merge.content,
          importance: merge.importance,
          quarantined: false,
          domain: merge.domain,
          validFrom: null,
          validUntil: null,
          supersededById: null,
          ownerConfirmed: false,
          pinned: false,
          source: 'consolidation',
          lastAccessedAt: null,
          lastConsolidatedAt: now,
        };
        tx.create(
          this.store.doc('memories', merge.id),
          encodeRecord({
            ...row,
            embedding: FieldValue.vector(merge.embedding),
            embeddingSpace: embeddingSpaceKey(this.space),
            retrievalRevision: randomUUID(),
          }),
        );
        tx.create(this.store.doc('memoryContentHashes', merge.contentHash), { memoryId: merge.id });
        merged.push(merge.id);
        for (const id of merge.memberIds) replacement.set(id, merge.id);
      }
      for (const row of input.retirements) {
        const winner = byId.get(row.supersededById);
        const loser = byId.get(row.id);
        if (!winner || !loser || (loser.get('ownerConfirmed') && !winner.get('ownerConfirmed')))
          throw new Error('Invalid consolidation retirement');
      }
      for (const [id, supersededById] of replacement) {
        const doc = byId.get(id);
        if (!doc) throw new Error('Consolidation retirement is missing');
        tx.update(doc.ref, { expiresAt: now, supersededById, lastConsolidatedAt: now });
        retired.push(id);
      }
      for (const fix of input.domainFixes) {
        const doc = byId.get(fix.id);
        if (doc && !replacement.has(fix.id) && doc.get('domain') !== fix.domain) {
          tx.update(doc.ref, { domain: fix.domain });
          domainsAssigned.push(fix.id);
        }
      }
      for (const item of input.timeline) {
        const doc = byId.get(item.id);
        if (doc && !replacement.has(item.id) && (item.validFrom || item.validUntil))
          tx.update(
            doc.ref,
            encodeRecord({
              ...(item.validFrom ? { validFrom: item.validFrom } : {}),
              ...(item.validUntil ? { validUntil: item.validUntil } : {}),
            }),
          );
      }
      for (const doc of docs)
        if (doc && !replacement.has(String(doc.get('id'))))
          tx.update(doc.ref, { lastConsolidatedAt: now });
      tx.set(
        this.store.doc('ownerCards', agentId),
        encodeRecord({
          agentId,
          content: '',
          compiledAt: now,
          invalidatedAt: now,
        }),
      );
      return { retired, merged, domainsAssigned };
    });
  }
}
