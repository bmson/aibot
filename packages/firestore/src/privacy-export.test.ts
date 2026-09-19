import { afterEach, describe, expect, it } from 'vitest';
import { FirestorePrivacyExportRepository } from './privacy-export.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe('Firestore privacy export repository', () => {
  const stores: ReturnType<typeof emulatorStore>[] = [];

  afterEach(async () => {
    await Promise.all(stores.splice(0).map(disposeStore));
  });

  it('paginates every owner row and excludes foreign, secret, vector, and tombstone fields', async () => {
    const store = emulatorStore();
    stores.push(store);
    const ownerId = '00000000-0000-4000-8000-000000000001';
    const foreignId = '00000000-0000-4000-8000-000000000002';
    const createdAt = new Date('2026-09-19T20:00:00.000Z');
    await store.doc('agents', ownerId).set({
      id: ownerId,
      name: 'Owner',
      credentialRefs: { secret: 'must-not-export' },
    });
    const batch = store.db.batch();
    for (let index = 0; index < 205; index += 1) {
      const id = `00000000-0000-4000-8001-${String(index).padStart(12, '0')}`;
      batch.set(store.doc('memories', id), {
        id,
        agentId: ownerId,
        category: 'knowledge',
        kind: 'fact',
        content: `Fact ${index}`,
        contentHash: `private-hash-${index}`,
        embedding: [0.1, 0.2],
        importance: 3,
        confidence: '0.90',
        originTrust: 'owner',
        quarantined: false,
        domain: null,
        ownerConfirmed: true,
        pinned: false,
        source: null,
        createdAt,
        expiresAt: null,
      });
    }
    batch.set(store.doc('memories', foreignId), {
      id: foreignId,
      agentId: foreignId,
      category: 'knowledge',
      kind: 'fact',
      content: 'Foreign fact',
      importance: 3,
      confidence: '0.90',
      originTrust: 'owner',
      quarantined: false,
      domain: null,
      ownerConfirmed: true,
      pinned: false,
      source: null,
      createdAt,
      expiresAt: null,
    });
    batch.set(store.doc('memoryTombstones', 'private-hash-0'), {
      id: 'tombstone',
      contentHash: 'private-hash-0',
      reason: 'owner_forget',
      createdAt,
    });
    batch.set(store.doc('knowledgeGraphRelations', 'active-relation'), {
      id: 'active-relation',
      agentId: ownerId,
      subjectEntityId: 'subject',
      predicate: 'knows',
      objectEntityId: 'object',
      sourceMemoryId: '00000000-0000-4000-8001-000000000001',
      evidenceQuote: null,
      confidence: '0.90',
      validFrom: null,
      validUntil: null,
      reviewStatus: 'unreviewed',
      createdAt,
    });
    batch.set(store.doc('knowledgeGraphRelations', 'forgotten-relation'), {
      id: 'forgotten-relation',
      agentId: ownerId,
      subjectEntityId: 'subject',
      predicate: 'knows',
      objectEntityId: 'object',
      sourceMemoryId: '00000000-0000-4000-8001-000000000000',
      evidenceQuote: null,
      confidence: '0.90',
      validFrom: null,
      validUntil: null,
      reviewStatus: 'unreviewed',
      createdAt,
    });
    await batch.commit();

    const result = await new FirestorePrivacyExportRepository(store).exportOwnerData();

    expect(result.memories).toHaveLength(204);
    expect(result.memories.map((row) => row.content)).toContain('Fact 204');
    expect(result.memories.map((row) => row.content)).not.toContain('Fact 0');
    expect(result.memories.map((row) => row.content)).not.toContain('Foreign fact');
    expect(result.memories[0]).not.toHaveProperty('embedding');
    expect(result.memories[0]).not.toHaveProperty('contentHash');
    expect(result.knowledgeGraph.relations.map((row) => row.id)).toEqual(['active-relation']);
    expect(result).not.toHaveProperty('memoryTombstones');
    expect(JSON.stringify(result)).not.toContain('must-not-export');
  });

  it('scopes graph projections and situation packs to the configured owner', async () => {
    const store = emulatorStore();
    stores.push(store);
    const ownerId = '00000000-0000-4000-8000-000000000011';
    const foreignId = '00000000-0000-4000-8000-000000000012';
    const createdAt = new Date('2026-09-19T20:00:00.000Z');
    await store.doc('agents', ownerId).set({ id: ownerId });
    await Promise.all([
      store.doc('knowledgeGraphEntities', 'owner-entity').set({
        id: 'owner-entity',
        agentId: ownerId,
        canonicalKey: 'topic:owner',
        label: 'Owner',
        preferredLabel: null,
        kind: 'topic',
        contactId: null,
        createdAt,
        updatedAt: createdAt,
      }),
      store.doc('knowledgeGraphEntities', 'foreign-entity').set({
        id: 'foreign-entity',
        agentId: foreignId,
        canonicalKey: 'topic:foreign',
        label: 'Foreign',
        preferredLabel: null,
        kind: 'topic',
        contactId: null,
        createdAt,
        updatedAt: createdAt,
      }),
      store.doc('situationPacks', 'owner-pack').set({
        id: 'owner-pack',
        agentId: ownerId,
        creationKey: 'owner',
        title: 'Owner pack',
        version: 1,
        archived: false,
        data: { decisions: ['visible'] },
        secretSentinel: 'must-not-export-pack-secret',
        createdAt,
        updatedAt: createdAt,
      }),
      store.doc('situationPacks', 'foreign-pack').set({
        id: 'foreign-pack',
        agentId: foreignId,
        creationKey: 'foreign',
        title: 'Foreign pack',
        version: 1,
        archived: false,
        data: { decisions: ['private'] },
        createdAt,
        updatedAt: createdAt,
      }),
      store.doc('ownerCards', ownerId).set({
        agentId: ownerId,
        content: 'Current compiled owner card',
        compiledAt: createdAt,
      }),
    ]);

    const result = await new FirestorePrivacyExportRepository(store).exportOwnerData();

    expect(result.knowledgeGraph.entities.map((row) => row.id)).toEqual(['owner-entity']);
    expect(result.situationPacks.map((row) => row.id)).toEqual(['owner-pack']);
    expect(JSON.stringify(result.situationPacks)).not.toContain('must-not-export-pack-secret');
    expect(result.compiledOwnerCard).toEqual({
      id: 1,
      content: 'Current compiled owner card',
      compiledAt: createdAt,
    });
  });
});
