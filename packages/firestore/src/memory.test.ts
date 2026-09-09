import { createHash, randomUUID } from 'node:crypto';
import type { EmbeddingSpace, Records } from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreMemoryRepository } from './memory.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

const space: EmbeddingSpace = { provider: 'test', model: 'unit', dimensions: 3, revision: '1' };
function memory(content: string, patch: Partial<Records['memories']> = {}): Records['memories'] {
  return {
    id: randomUUID(),
    agentId: 'agent',
    content,
    contentHash: createHash('sha256').update(content).digest('hex'),
    createdAt: new Date(),
    expiresAt: null,
    embedding: [1, 0, 0],
    sourceTaskId: null,
    kind: 'fact',
    confidence: '1',
    goalId: null,
    originTrust: 'owner',
    category: 'knowledge',
    importance: 3,
    quarantined: false,
    subjectContactId: null,
    domain: null,
    validFrom: null,
    validUntil: null,
    supersededById: null,
    ownerConfirmed: true,
    pinned: false,
    source: 'test source',
    lastAccessedAt: null,
    lastConsolidatedAt: null,
    ...patch,
  };
}

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore vector feasibility', () => {
  let store: InstallationStore;
  let repo: FirestoreMemoryRepository;
  beforeEach(() => {
    store = emulatorStore();
    repo = new FirestoreMemoryRepository(store, space);
  });
  afterEach(async () => {
    await disposeStore(store);
  });
  it('retrieves matching vectors with provenance and excludes private/stale/other-agent records', async () => {
    await repo.save(memory('relevant'));
    await repo.save(memory('unrelated', { embedding: [0, 1, 0] }));
    await repo.save(memory('quarantined', { quarantined: true }));
    await repo.save(memory('expired', { expiresAt: new Date(0) }));
    await repo.save(memory('superseded', { supersededById: 'new' }));
    await repo.save(memory('other', { agentId: 'other' }));
    const result = await repo.retrieve({ agentId: 'agent', vector: [1, 0, 0], limit: 5 });
    expect(result.memories.map((m) => m.content)).toEqual(['relevant', 'unrelated']);
    expect(result.memories[0]).toMatchObject({ source: 'test source', similarity: 1 });
    expect(result.memories[0]).not.toHaveProperty('embedding');
    expect(result.memories[0]).not.toHaveProperty('retrievalRevision');
  });
  it('keeps incompatible model versions out of recall even with equal dimensions', async () => {
    await repo.save(memory('old'));
    const newer = new FirestoreMemoryRepository(store, { ...space, revision: '2' });
    expect((await newer.retrieve({ agentId: 'agent', vector: [1, 0, 0] })).memories).toEqual([]);
    await expect(repo.retrieve({ agentId: 'agent', vector: [1, 0] })).rejects.toThrow(
      'embedding space',
    );
    await expect(repo.retrieve({ agentId: 'agent', vector: [0, 0, 0] })).rejects.toThrow(
      'embedding space',
    );
  });
  it('concurrent erasure wins over re-ingestion and its tombstone survives retries', async () => {
    const row = memory('forgotten');
    await Promise.all([repo.save(row), repo.forget(row.contentHash)]);
    expect(await repo.save({ ...row, id: randomUUID() })).toBe(false);
    expect((await repo.retrieve({ agentId: 'agent', vector: [1, 0, 0] })).memories).toEqual([]);
    expect((await store.doc('memoryTombstones', row.contentHash).get()).exists).toBe(true);
  });
});
