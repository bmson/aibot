import { afterEach, describe, expect, it, vi } from 'vitest';
import { FirestorePrivacyErasureRepository } from './privacy-erasure.js';
import { FirestoreProfileLibraryRepository } from './profile-library.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore profile library erasure fence',
  () => {
    const stores: ReturnType<typeof emulatorStore>[] = [];
    afterEach(async () => Promise.all(stores.splice(0).map(disposeStore)));

    it('shares the memory scan and loads graph metadata only for the visible page at scale', async () => {
      const store = emulatorStore();
      stores.push(store);
      const agentId = 'profile-library-scale-owner';
      const count = 900;
      const batchSize = 450;
      const createdAt = (index: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, index));
      for (let start = 0; start < count; start += batchSize) {
        const batch = store.db.batch();
        for (let index = start; index < Math.min(count, start + batchSize); index += 1) {
          const id = `scale-memory-${String(index).padStart(4, '0')}`;
          batch.set(store.doc('memories', id), {
            id,
            agentId,
            category: 'knowledge',
            content: `Scale fact ${index}`,
            contentHash: `scale-hash-${index}`,
            domain: 'general',
            source: index % 2 === 0 ? 'scale-a' : 'scale-b',
            createdAt: createdAt(index),
            expiresAt: null,
            lastConsolidatedAt: null,
            subjectContactId: null,
            quarantined: false,
            ownerConfirmed: true,
            pinned: false,
            importance: 3,
            originTrust: 'owner',
            embedding: index === count - 1 ? [0.1, 0.2] : null,
          });
        }
        await batch.commit();
      }
      const pageMemoryId = `scale-memory-${String(count - 1).padStart(4, '0')}`;
      await Promise.all([
        store.doc('knowledgeGraphSources', pageMemoryId).set({
          memoryId: pageMemoryId,
          status: 'ready',
          contentHash: `scale-hash-${count - 1}`,
          extractionVersion: 99,
        }),
        store.doc('knowledgeGraphRelations', 'scale-page-relation').set({
          id: 'scale-page-relation',
          agentId,
          sourceMemoryId: pageMemoryId,
          subjectEntityId: 'scale-subject',
          objectEntityId: 'scale-object',
          predicate: 'knows',
          reviewStatus: 'pending',
          evidenceQuote: 'Scale fact 899',
        }),
        store.doc('knowledgeGraphRelations', 'scale-off-page-relation').set({
          id: 'scale-off-page-relation',
          agentId,
          sourceMemoryId: 'memory-not-on-page',
          subjectEntityId: 'scale-subject',
          objectEntityId: 'scale-object',
          predicate: 'knows',
          reviewStatus: 'pending',
          evidenceQuote: 'off-page fact',
        }),
      ]);

      const repository = new FirestoreProfileLibraryRepository(store);
      const internals = repository as unknown as {
        readMemories: (id: string) => Promise<unknown>;
      };
      const physicalScans = vi.spyOn(internals, 'readMemories');
      const input = {
        state: 'in-use' as const,
        filter: 'all' as const,
        query: '',
        page: 1,
        pageSize: 60,
        now: new Date(Date.UTC(2027, 0, 1)),
        extractionVersion: 2,
      };

      const [page, filters, connected, unconnected] = await Promise.all([
        repository.list(agentId, input),
        repository.listFilters(agentId),
        repository.list(agentId, { ...input, connectivity: 'connected' }),
        repository.list(agentId, { ...input, connectivity: 'unconnected' }),
      ]);
      expect(physicalScans).toHaveBeenCalledTimes(1);
      expect(page).toMatchObject({ total: count, page: 1, totalPages: 15 });
      expect(page.rows).toHaveLength(60);
      expect(page.rows[0]).toMatchObject({
        memory: { id: pageMemoryId },
        connectionCount: 1,
        source: { status: 'ready' },
      });
      expect(page.rows.map((row) => row.memory.id)).toEqual(
        Array.from(
          { length: 60 },
          (_, index) => `scale-memory-${String(count - 1 - index).padStart(4, '0')}`,
        ),
      );
      expect(connected).toMatchObject({ total: 1, rows: [{ memory: { id: pageMemoryId } }] });
      expect(unconnected).toMatchObject({ total: count - 1 });
      expect(unconnected.rows[0]?.memory.id).toBe(
        `scale-memory-${String(count - 2).padStart(4, '0')}`,
      );
      expect(filters).toEqual({ subjects: [], sources: ['scale-a', 'scale-b'] });
    });

    it('blocks lists and filters during active or malformed erasure, then allows a completed job', async () => {
      const store = emulatorStore();
      stores.push(store);
      const agentId = 'profile-library-erasure-owner';
      const memoryId = 'profile-library-erasure-memory';
      const now = new Date('2026-09-22T12:00:00Z');
      await store.doc('memories', memoryId).set({
        id: memoryId,
        agentId,
        category: 'knowledge',
        content: 'A private owner fact',
        contentHash: 'profile-library-erasure-hash',
        createdAt: now,
        expiresAt: null,
        quarantined: false,
        pinned: false,
        ownerConfirmed: true,
        importance: 3,
        source: 'test',
        subjectContactId: null,
        lastConsolidatedAt: null,
      });
      const repository = new FirestoreProfileLibraryRepository(store);
      const input = {
        state: 'in-use' as const,
        filter: 'all' as const,
        query: '',
        page: 1,
        pageSize: 10,
        now: new Date(now.getTime() + 1000),
        extractionVersion: 1,
      };

      expect((await repository.list(agentId, input)).rows.map((row) => row.memory.id)).toEqual([
        memoryId,
      ]);
      expect(await repository.listFilters(agentId)).toMatchObject({ sources: ['test'] });

      for (const status of ['active', 'unknown'] as const) {
        await store.doc('privacyErasureJobs', agentId).set({ agentId, status });
        await expect(repository.list(agentId, input)).rejects.toThrow(
          'Privacy erasure is in progress',
        );
        await expect(repository.listFilters(agentId)).rejects.toThrow(
          'Privacy erasure is in progress',
        );
      }

      await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'complete' });
      expect((await repository.list(agentId, input)).rows.map((row) => row.memory.id)).toEqual([
        memoryId,
      ]);
      expect(await repository.listFilters(agentId)).toMatchObject({ sources: ['test'] });
    });

    it.each(['list', 'filters'] as const)(
      'rejects a %s result when erasure completes during the read',
      async (method) => {
        const store = emulatorStore();
        stores.push(store);
        const agentId = 'profile-library-racing-owner';
        const memoryId = 'profile-library-racing-memory';
        const now = new Date('2026-09-22T12:00:00Z');
        await Promise.all([
          store.doc('agents', agentId).set({ id: agentId }),
          store.doc('memories', memoryId).set({
            id: memoryId,
            agentId,
            category: 'knowledge',
            content: 'A private owner fact',
            contentHash: 'profile-library-racing-hash',
            createdAt: now,
            expiresAt: null,
            quarantined: false,
            pinned: false,
            ownerConfirmed: true,
            importance: 3,
            source: 'test',
            subjectContactId: null,
            lastConsolidatedAt: null,
          }),
        ]);
        const repository = new FirestoreProfileLibraryRepository(store);
        const erasure = new FirestorePrivacyErasureRepository(store);
        const originalDoc = store.doc.bind(store);
        let fenceReads = 0;
        const spy = vi.spyOn(store, 'doc').mockImplementation((collection, id) => {
          const ref = originalDoc(collection, id);
          if (collection === 'privacyErasureJobs' && id === agentId) {
            const get = ref.get.bind(ref);
            vi.spyOn(ref, 'get').mockImplementation(async () => {
              fenceReads += 1;
              if (fenceReads === 2) {
                await erasure.erase();
                await erasure.complete();
              }
              return get();
            });
          }
          return ref;
        });
        try {
          const read =
            method === 'list'
              ? repository.list(agentId, {
                  state: 'in-use',
                  filter: 'all',
                  query: '',
                  page: 1,
                  pageSize: 10,
                  now: new Date(now.getTime() + 1000),
                  extractionVersion: 1,
                })
              : repository.listFilters(agentId);
          await expect(read).rejects.toThrow('Privacy erasure changed during read');
          expect(fenceReads).toBe(2);
          expect((await originalDoc('privacyErasureJobs', agentId).get()).get('status')).toBe(
            'complete',
          );
        } finally {
          spy.mockRestore();
        }
      },
    );
  },
);
