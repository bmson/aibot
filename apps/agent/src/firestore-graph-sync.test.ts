import { createHash, randomUUID } from 'node:crypto';
import { syncKnowledgeGraph } from '@assistant/core/memory/knowledge-graph';
import type { ModelRouter } from '@assistant/core/model-router';
import { FirestoreKnowledgeGraphSyncRepository } from '@assistant/firestore';
import { importWorkspaceBundle } from '@assistant/firestore/workspace-migration';
import {
  checksumV3,
  deterministicMigrationCompare,
  type MigrationBundle,
  type MigrationRecord,
  type Records,
  serializeMigrationTimestamp,
  serializeMigrationVector,
} from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeRecord, type InstallationStore } from '../../../packages/firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore knowledge graph sync', () => {
  let store: InstallationStore;
  let repository: FirestoreKnowledgeGraphSyncRepository;
  const agentId = 'graph-sync-owner';
  const contactId = 'graph-sync-contact';

  beforeEach(async () => {
    store = emulatorStore();
    repository = new FirestoreKnowledgeGraphSyncRepository(store);
    await Promise.all([
      store.doc('agents', agentId).set({
        id: agentId,
        name: 'Graph Owner',
        timezone: 'UTC',
        locale: 'en',
      }),
      store.doc('contacts', contactId).set(
        encodeRecord({
          id: contactId,
          name: 'Graph Owner',
          aliases: ['Owner'],
          emails: [],
          phones: [],
          relationship: 'self',
          notes: '',
          trust: 'owner',
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      ),
    ]);
  });

  afterEach(async () => disposeStore(store));

  async function seedMemory(content: string) {
    const id = randomUUID();
    const contentHash = hash(content);
    const retrievalRevision = randomUUID();
    const row: Records['memories'] = {
      id,
      createdAt: new Date('2026-09-19T12:00:00Z'),
      agentId,
      expiresAt: null,
      embedding: [1, 0, 0],
      sourceTaskId: null,
      kind: 'fact',
      confidence: '0.80',
      contentHash,
      goalId: null,
      originTrust: 'owner',
      category: 'knowledge',
      content,
      importance: 4,
      quarantined: false,
      subjectContactId: contactId,
      domain: null,
      validFrom: null,
      validUntil: null,
      supersededById: null,
      ownerConfirmed: true,
      pinned: false,
      source: 'test',
      lastAccessedAt: null,
      lastConsolidatedAt: null,
    };
    await Promise.all([
      store.doc('memories', id).set(encodeRecord({ ...row, retrievalRevision })),
      store.doc('memoryContentHashes', contentHash).set({ memoryId: id }),
    ]);
    return { row, retrievalRevision };
  }

  function routerFor(content: string, wait?: Promise<void>, calls?: { value: number }) {
    return {
      async object() {
        if (calls) calls.value += 1;
        await wait;
        return {
          ok: true,
          object: {
            relationships: [
              {
                subject: { label: 'Owner', kind: 'person' },
                predicate: 'works_at',
                object: { label: 'Acme', kind: 'organization' },
                evidenceQuote: content,
                confidence: 0.9,
              },
            ],
          },
        };
      },
    } as unknown as ModelRouter;
  }

  it('runs model-free from SQL and preserves imported entity and alias identities', async () => {
    const content = 'Owner works at Acme.';
    const { row } = await seedMemory(content);
    await Promise.all([
      store.doc('knowledgeGraphEntities', 'imported-owner').set({
        id: 'imported-owner',
        agentId,
        canonicalKey: `contact:${contactId}`,
        label: 'Old Owner Label',
        preferredLabel: null,
        kind: 'person',
        contactId,
        createdAt: new Date('2020-01-01T00:00:00Z'),
        updatedAt: new Date('2020-01-01T00:00:00Z'),
      }),
      store.doc('knowledgeGraphEntities', 'imported-company').set({
        id: 'imported-company',
        agentId,
        canonicalKey: 'project:legacy acme',
        label: 'Acme',
        preferredLabel: null,
        kind: 'project',
        contactId: null,
        createdAt: new Date('2020-01-01T00:00:00Z'),
        updatedAt: new Date('2020-01-01T00:00:00Z'),
      }),
      store.doc('knowledgeGraphEntityAliases', 'imported-alias').set({
        id: 'imported-alias',
        agentId,
        canonicalKey: 'organization:acme',
        entityId: 'imported-company',
        createdAt: new Date('2020-01-01T00:00:00Z'),
      }),
      store.doc('knowledgeGraphRelations', 'imported-relation').set({
        id: 'imported-relation',
        createdAt: new Date('2020-01-01T00:00:00Z'),
        agentId,
        sourceFingerprint: `contact:${contactId}|works_at|organization:acme`,
        confidence: '0.70',
        validFrom: null,
        validUntil: null,
        subjectEntityId: 'imported-owner',
        predicate: 'works_at',
        objectEntityId: 'imported-company',
        sourceMemoryId: row.id,
        evidenceQuote: content,
        ordinal: 1,
        reviewStatus: 'confirmed',
        reviewedAt: new Date('2020-01-01T00:00:00Z'),
      }),
    ]);

    const result = await syncKnowledgeGraph(
      { graphSync: repository, router: routerFor(content) },
      { agentId },
    );

    expect(result).toMatchObject({ candidates: 1, processed: 1, relationships: 1, entities: 2 });
    const source = await store.doc('knowledgeGraphSources', row.id).get();
    expect(source.data()).toMatchObject({
      memoryId: row.id,
      agentId,
      contentHash: row.contentHash,
      status: 'ready',
      extractionVersion: 2,
    });
    const relations = await store
      .collection('knowledgeGraphRelations')
      .where('sourceMemoryId', '==', row.id)
      .get();
    expect(relations.size).toBe(1);
    expect(relations.docs[0]?.data()).toMatchObject({
      id: 'imported-relation',
      agentId,
      subjectEntityId: 'imported-owner',
      objectEntityId: 'imported-company',
      sourceMemoryId: row.id,
      evidenceQuote: content,
      reviewStatus: 'confirmed',
    });
    expect((await store.doc('knowledgeGraphEntities', 'imported-owner').get()).get('label')).toBe(
      'Graph Owner',
    );
    expect(
      (await store.doc('knowledgeGraphEntities', 'imported-company').get()).data(),
    ).toMatchObject({
      canonicalKey: 'project:legacy acme',
      kind: 'project',
    });
  });

  it('keeps an imported ready, reviewed graph relation without re-extraction', async () => {
    const migrationStore = emulatorStore();
    const content = 'Owner works at Acme.';
    const contentHash = hash(content);
    const memoryId = randomUUID();
    const subjectId = randomUUID();
    const objectId = randomUUID();
    const relationId = randomUUID();
    const createdAt = serializeMigrationTimestamp('2026-09-19 12:00:00.000000+00');
    const records: MigrationRecord[] = [
      {
        table: 'agents',
        collection: 'agents',
        id: agentId,
        data: {
          id: agentId,
          name: 'Graph Owner',
          email: 'owner@example.test',
          workspacePrefix: 'workspace/test',
          timezone: 'UTC',
          locale: 'en',
        },
        checksum: '',
      },
      {
        table: 'memories',
        collection: 'memories',
        id: memoryId,
        data: {
          id: memoryId,
          createdAt,
          agentId,
          category: 'knowledge',
          kind: 'fact',
          content,
          contentHash,
          embedding: serializeMigrationVector([1, 0, 0]),
          confidence: '0.80',
          quarantined: false,
          expiresAt: null,
          subjectContactId: null,
        },
        checksum: '',
      },
      {
        table: 'knowledge_graph_sources',
        collection: 'knowledgeGraphSources',
        id: memoryId,
        data: {
          memoryId,
          createdAt,
          updatedAt: createdAt,
          contentHash,
          subjectContactId: null,
          extractionVersion: 2,
          status: 'ready',
          attempts: 1,
          lastError: null,
          nextRetryAt: null,
        },
        checksum: '',
      },
      ...[
        { id: subjectId, canonicalKey: 'person:owner', label: 'Owner', kind: 'person' },
        { id: objectId, canonicalKey: 'organization:acme', label: 'Acme', kind: 'organization' },
      ].map(
        (entity): MigrationRecord => ({
          table: 'knowledge_graph_entities',
          collection: 'knowledgeGraphEntities',
          id: entity.id,
          data: {
            ...entity,
            agentId,
            createdAt,
            updatedAt: createdAt,
            preferredLabel: null,
            contactId: null,
          },
          checksum: '',
        }),
      ),
      {
        table: 'knowledge_graph_relations',
        collection: 'knowledgeGraphRelations',
        id: relationId,
        data: {
          id: relationId,
          createdAt,
          agentId,
          subjectEntityId: subjectId,
          objectEntityId: objectId,
          sourceMemoryId: memoryId,
          sourceFingerprint: 'person:owner|works_at|organization:acme',
          predicate: 'works_at',
          evidenceQuote: content,
          ordinal: 1,
          confidence: '0.80',
          validFrom: null,
          validUntil: null,
          reviewStatus: 'confirmed',
          reviewedAt: createdAt,
        },
        checksum: '',
      },
    ];
    for (const record of records) record.checksum = checksumV3(record.data);
    records.sort((left, right) =>
      deterministicMigrationCompare(`${left.table}:${left.id}`, `${right.table}:${right.id}`),
    );
    const tables = Object.fromEntries(
      [...new Set(records.map((record) => record.table))].map((table) => {
        const rows = records.filter((record) => record.table === table);
        return [
          table,
          { collection: rows[0]?.collection, count: rows.length, checksum: checksumV3(rows) },
        ];
      }),
    ) as MigrationBundle['manifest']['tables'];
    const target = {
      projectId: 'demo-assistant-test',
      databaseId: '(default)',
      installationId: migrationStore.installationId,
    };
    const bundle: MigrationBundle = {
      records,
      manifest: {
        format: 'assistant-workspace-migration',
        formatVersion: 3,
        mode: 'export',
        source: {
          kind: 'postgresql',
          agentId,
          scope: 'installation',
          snapshot: '1-1-1',
          embeddingSpace: { provider: 'test', model: 'migration', dimensions: 3, revision: '1' },
        },
        target,
        tables,
        coverage: {
          complete: false,
          supportedTables: Object.keys(
            tables,
          ) as MigrationBundle['manifest']['coverage']['supportedTables'],
          omittedTables: ['remaining PostgreSQL tables'],
        },
        recordCount: records.length,
        bundleChecksum: checksumV3(records),
        unsupportedTables: [],
      },
    };

    try {
      expect(
        await importWorkspaceBundle(migrationStore, bundle, {
          sourceAgentId: agentId,
          target,
          mode: 'write',
        }),
      ).toMatchObject({ verified: true });
      const model = vi.fn(() => {
        throw new Error('ready graph source must not call the model');
      });
      const result = await syncKnowledgeGraph(
        {
          graphSync: new FirestoreKnowledgeGraphSyncRepository(migrationStore),
          router: { object: model } as unknown as ModelRouter,
        },
        { agentId },
      );
      expect(result).toMatchObject({ candidates: 0, processed: 0 });
      expect(model).not.toHaveBeenCalled();
      expect(
        (await migrationStore.doc('knowledgeGraphRelations', relationId).get()).data(),
      ).toMatchObject({
        id: relationId,
        reviewStatus: 'confirmed',
        sourceMemoryId: memoryId,
      });
    } finally {
      await disposeStore(migrationStore);
    }
  });

  it('checkpoints extraction failures with a bounded retry deadline', async () => {
    const content = 'Owner works at Acme.';
    const { row } = await seedMemory(content);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const result = await syncKnowledgeGraph(
        {
          graphSync: repository,
          router: {
            async object() {
              throw new Error('temporary provider outage');
            },
          } as unknown as ModelRouter,
        },
        { agentId },
      );
      expect(result).toMatchObject({ candidates: 1, processed: 0, failed: 1, quarantined: 0 });
      const source = await store.doc('knowledgeGraphSources', row.id).get();
      expect(source.data()).toMatchObject({
        memoryId: row.id,
        agentId,
        contentHash: row.contentHash,
        status: 'failed',
        attempts: 1,
        lastError: 'temporary provider outage',
      });
      expect(source.get('nextRetryAt')).toBeDefined();
    } finally {
      error.mockRestore();
    }
  });

  it('reextracts a ready source when its retrieval revision changes', async () => {
    const content = 'Owner works at Acme.';
    const { row } = await seedMemory(content);
    const calls = { value: 0 };
    const router = routerFor(content, undefined, calls);
    expect(await syncKnowledgeGraph({ graphSync: repository, router }, { agentId })).toMatchObject({
      processed: 1,
    });
    await store.doc('memories', row.id).update({ retrievalRevision: randomUUID() });
    expect(await syncKnowledgeGraph({ graphSync: repository, router }, { agentId })).toMatchObject({
      candidates: 1,
      processed: 1,
    });
    expect(calls.value).toBe(2);
  });

  it('drops an extraction after a retrieval revision changes without a content change', async () => {
    const content = 'Owner works at Acme.';
    const { row } = await seedMemory(content);
    const started = deferred();
    const release = deferred();
    const router = routerFor(content, release.promise);
    const slowRouter = {
      async object() {
        started.resolve();
        return router.object('extract', {} as never);
      },
    } as unknown as ModelRouter;
    const syncing = syncKnowledgeGraph({ graphSync: repository, router: slowRouter }, { agentId });
    await started.promise;
    await store.doc('memories', row.id).update({ retrievalRevision: randomUUID() });
    release.resolve();
    expect(await syncing).toMatchObject({ processed: 0, relationships: 0, entities: 0 });
    expect(
      await store.collection('knowledgeGraphRelations').where('sourceMemoryId', '==', row.id).get(),
    ).toMatchObject({ empty: true });
  });

  it.each(['correction', 'forget'] as const)(
    'drops an extraction that finishes after a source %s',
    async (mutation) => {
      const content = 'Owner works at Acme.';
      const { row } = await seedMemory(content);
      const started = deferred();
      const release = deferred();
      const router = {
        async object() {
          started.resolve();
          await release.promise;
          return routerFor(content).object('extract', {} as never);
        },
      } as unknown as ModelRouter;
      const syncing = syncKnowledgeGraph({ graphSync: repository, router }, { agentId });
      await started.promise;

      if (mutation === 'correction') {
        const corrected = 'Owner works at Orbit.';
        const correctedHash = hash(corrected);
        const batch = store.db.batch();
        batch.update(store.doc('memories', row.id), {
          content: corrected,
          contentHash: correctedHash,
          retrievalRevision: randomUUID(),
        });
        batch.delete(store.doc('memoryContentHashes', row.contentHash));
        batch.set(store.doc('memoryContentHashes', correctedHash), { memoryId: row.id });
        batch.set(store.doc('memoryTombstones', row.contentHash), {
          contentHash: row.contentHash,
          reason: 'owner_correct',
          createdAt: new Date(),
        });
        await batch.commit();
      } else {
        const batch = store.db.batch();
        batch.delete(store.doc('memories', row.id));
        batch.delete(store.doc('memoryContentHashes', row.contentHash));
        batch.set(store.doc('memoryTombstones', row.contentHash), {
          contentHash: row.contentHash,
          reason: 'owner_forget',
          createdAt: new Date(),
        });
        batch.set(store.doc('graphDeletionIntents', row.id), {
          memoryId: row.id,
          agentId,
          contentHash: row.contentHash,
          createdAt: new Date(),
        });
        await batch.commit();
      }
      release.resolve();

      expect(await syncing).toMatchObject({ processed: 0, relationships: 0, entities: 0 });
      expect(
        await store
          .collection('knowledgeGraphRelations')
          .where('sourceMemoryId', '==', row.id)
          .get(),
      ).toMatchObject({ empty: true });
    },
  );

  it('allows only one concurrent worker to claim and extract a source', async () => {
    const content = 'Owner works at Acme.';
    await seedMemory(content);
    const release = deferred();
    const calls = { value: 0 };
    const router = routerFor(content, release.promise, calls);
    const first = syncKnowledgeGraph({ graphSync: repository, router }, { agentId });
    const second = syncKnowledgeGraph({ graphSync: repository, router }, { agentId });
    while (calls.value === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    release.resolve();
    const results = await Promise.all([first, second]);
    expect(calls.value).toBe(1);
    expect(results[0].processed + results[1].processed).toBe(1);
  });
});
