import { createHash, randomUUID } from 'node:crypto';
import { type EmbeddingSpace, type Records, validateEmbedding } from '@assistant/persistence';
import { FieldValue } from '@google-cloud/firestore';
import { decodeRecord, encodeRecord, type InstallationStore } from './store.js';

export function embeddingSpaceKey(space: EmbeddingSpace): string {
  return createHash('sha256')
    .update(JSON.stringify([space.provider, space.model, space.dimensions, space.revision]))
    .digest('hex');
}

/** Initial vector feasibility adapter; graph/lexical ranking is still owned by the SQL runtime. */
export class FirestoreMemoryRepository {
  constructor(
    readonly store: InstallationStore,
    readonly space: EmbeddingSpace,
  ) {}

  async save(memory: Records['memories']): Promise<boolean> {
    if (!memory.embedding) throw new Error('Memory requires an embedding');
    validateEmbedding(this.space, memory.embedding);
    if (!memory.contentHash) throw new Error('Memory requires a content hash');
    const ref = this.store.doc('memories', memory.id);
    const hashRef = this.store.doc('memoryContentHashes', memory.contentHash);
    const tombstoneRef = this.store.doc('memoryTombstones', memory.contentHash);
    return this.store.db.runTransaction(async (tx) => {
      const [existing, hash, tombstone] = await tx.getAll(ref, hashRef, tombstoneRef);
      if (tombstone?.exists) return false;
      if (existing?.exists || hash?.exists) return false;
      tx.create(
        ref,
        encodeRecord({
          ...memory,
          embedding: FieldValue.vector(memory.embedding as number[]),
          embeddingSpace: embeddingSpaceKey(this.space),
          retrievalRevision: randomUUID(),
        }),
      );
      tx.create(hashRef, { memoryId: memory.id });
      return true;
    });
  }

  /** Owner authorization belongs to the application service; hashes are installation-scoped. */
  async forget(contentHash: string, reason = 'owner requested erasure'): Promise<void> {
    const hashRef = this.store.doc('memoryContentHashes', contentHash);
    await this.store.db.runTransaction(async (tx) => {
      const hash = await tx.get(hashRef);
      const now = this.store.now();
      tx.set(this.store.doc('memoryTombstones', contentHash), {
        id: contentHash,
        contentHash,
        reason,
        createdAt: now,
      });
      if (hash.exists) tx.delete(this.store.doc('memories', hash.get('memoryId')));
      tx.delete(hashRef);
    });
  }

  async retrieve(input: {
    agentId: string;
    vector: number[];
    limit?: number;
    candidateLimit?: number;
  }) {
    validateEmbedding(this.space, input.vector);
    const limit = input.limit ?? 5;
    const candidateLimit = input.candidateLimit ?? Math.min(1000, limit * 4);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isInteger(candidateLimit) ||
      candidateLimit < limit ||
      candidateLimit > 1000
    )
      throw new Error('Invalid memory retrieval bounds');
    const candidates = await this.store
      .collection('memories')
      .where('agentId', '==', input.agentId)
      .where('quarantined', '==', false)
      .where('embeddingSpace', '==', embeddingSpaceKey(this.space))
      .findNearest({
        vectorField: 'embedding',
        queryVector: input.vector,
        distanceMeasure: 'COSINE',
        limit: candidateLimit,
        distanceResultField: 'vectorDistance',
      })
      .get();
    if (candidates.empty) return { memories: [], candidateLimitReached: false };
    // Re-read source records plus tombstones at one consistent snapshot. Never return a
    // cached vector hit after erasure or a changed privacy/trust state.
    return this.store.db.runTransaction(
      async (tx) => {
        const refs = candidates.docs.flatMap((doc) => [
          doc.ref,
          this.store.doc('memoryTombstones', doc.get('contentHash')),
        ]);
        const records = await tx.getAll(...refs);
        const now = this.store.now();
        const memories: Array<Omit<Records['memories'], 'embedding'> & { similarity: number }> = [];
        for (let i = 0; i < candidates.docs.length; i++) {
          const snapshot = records[i * 2],
            tombstone = records[i * 2 + 1],
            candidate = candidates.docs[i];
          if (
            !snapshot?.exists ||
            tombstone?.exists ||
            !candidate ||
            snapshot.get('retrievalRevision') !== candidate.get('retrievalRevision')
          )
            continue;
          const row = decodeRecord<Records['memories']>(snapshot.data());
          if (
            row.agentId !== input.agentId ||
            row.quarantined ||
            row.supersededById ||
            (row.expiresAt && row.expiresAt <= now) ||
            snapshot.get('embeddingSpace') !== embeddingSpaceKey(this.space)
          )
            continue;
          const { embedding: _embedding, ...fields } = row;
          // decodeRecord keeps additive database fields; explicitly omit vector/index metadata.
          const {
            embeddingSpace: _space,
            retrievalRevision: _revision,
            ...safe
          } = fields as typeof fields & { embeddingSpace?: string; retrievalRevision?: string };
          memories.push({ ...safe, similarity: 1 - Number(candidate.get('vectorDistance')) });
          if (memories.length === limit) break;
        }
        return { memories, candidateLimitReached: candidates.size === candidateLimit };
      },
      { readOnly: true },
    );
  }
}
