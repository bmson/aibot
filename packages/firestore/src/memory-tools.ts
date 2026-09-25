import { randomUUID } from 'node:crypto';
import type {
  EmbeddingSpace,
  MemoryRecallInput,
  MemoryRecallResult,
  MemorySaveInput,
  MemorySaveResult,
  MemoryToolRepository,
} from '@assistant/persistence';
import { resolveFirestoreSubjectContact } from './contact-lookup.js';
import { FirestoreMemoryRepository } from './memory.js';
import type { InstallationStore } from './store.js';

function lexicalTerms(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((term) => term.length > 2)
    .slice(0, 5);
}

function validateSave(input: MemorySaveInput): void {
  if (!input.agentId || !input.content || !input.contentHash || !input.originTrust)
    throw new Error('Invalid memory save');
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)
    throw new Error('Invalid memory confidence');
  if (!Number.isInteger(input.importance) || input.importance < 1 || input.importance > 5)
    throw new Error('Invalid memory importance');
  if (input.expiresAt && !Number.isFinite(input.expiresAt.getTime()))
    throw new Error('Invalid memory expiry');
}

export class FirestoreMemoryToolRepository implements MemoryToolRepository {
  readonly kind = 'memory-tool-repository' as const;
  readonly embeddingSpace: EmbeddingSpace;
  private readonly vectors: FirestoreMemoryRepository;

  constructor(
    readonly store: InstallationStore,
    embeddingSpace: EmbeddingSpace,
  ) {
    this.embeddingSpace = embeddingSpace;
    this.vectors = new FirestoreMemoryRepository(store, embeddingSpace);
  }

  async save(input: MemorySaveInput): Promise<MemorySaveResult> {
    validateSave(input);
    const tombstone = await this.store.doc('memoryTombstones', input.contentHash).get();
    if (tombstone.exists)
      return { saved: false, duplicate: false, tombstoned: true, quarantined: input.quarantined };
    const subjectContactId = input.subject
      ? await resolveFirestoreSubjectContact(
          this.store,
          input.agentId,
          input.subject,
          input.subjectRelationship,
        )
      : null;
    const now = this.store.now();
    const id = randomUUID();
    const saved = await this.vectors.save({
      id,
      createdAt: now,
      agentId: input.agentId,
      expiresAt: input.expiresAt ?? null,
      embedding: input.embedding,
      sourceTaskId: input.sourceTaskId ?? null,
      kind: input.kind,
      confidence: input.confidence.toFixed(2),
      contentHash: input.contentHash,
      goalId: null,
      originTrust: input.originTrust,
      category: input.category,
      content: input.content,
      importance: input.importance,
      quarantined: input.quarantined,
      subjectContactId,
      domain: input.domain ?? null,
      validFrom: null,
      validUntil: null,
      supersededById: null,
      ownerConfirmed: false,
      pinned: false,
      source: null,
      lastAccessedAt: null,
      lastConsolidatedAt: null,
    });
    if (saved)
      return {
        id,
        saved: true,
        duplicate: false,
        tombstoned: false,
        quarantined: input.quarantined,
      };
    const after = await this.store.doc('memoryTombstones', input.contentHash).get();
    return {
      saved: false,
      duplicate: !after.exists,
      tombstoned: after.exists,
      quarantined: input.quarantined,
    };
  }

  async recall(input: MemoryRecallInput): Promise<MemoryRecallResult> {
    if (
      !input.agentId ||
      !input.query ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 20
    )
      throw new Error('Invalid memory recall');
    const now = input.now ?? this.store.now();
    if (!Number.isFinite(now.getTime())) throw new Error('Invalid memory recall time');
    const candidateLimit = Math.min(100, input.limit * 4);
    const result = await this.vectors.retrieve({
      agentId: input.agentId,
      vector: input.embedding,
      limit: candidateLimit,
      candidateLimit,
    });
    const terms = lexicalTerms(input.query);
    const ranked = result.memories
      .map((memory) => ({
        memory,
        lexical: terms.some((term) => new RegExp(`\\b${term}\\b`, 'i').test(memory.content)),
      }))
      .sort((left, right) => {
        const leftScore = left.memory.similarity + (left.lexical ? 0.06 : 0);
        const rightScore = right.memory.similarity + (right.lexical ? 0.06 : 0);
        return rightScore - leftScore;
      })
      .slice(0, input.limit);
    if (ranked.length) {
      await this.store.db.runTransaction(async (tx) => {
        const snapshots = await tx.getAll(
          ...ranked.map(({ memory }) => this.store.doc('memories', memory.id)),
        );
        for (const snapshot of snapshots) {
          if (snapshot.exists) tx.update(snapshot.ref, { lastAccessedAt: now });
        }
      });
    }
    return {
      memories: ranked.map(({ memory }) => memory),
      candidateLimitReached: result.candidateLimitReached,
    };
  }
}
