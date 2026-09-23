import { afterEach, describe, expect, it, vi } from 'vitest';
import { FirestorePrivacyErasureRepository } from './privacy-erasure.js';
import { FirestoreProfileLibraryRepository } from './profile-library.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore profile library erasure fence',
  () => {
    const stores: ReturnType<typeof emulatorStore>[] = [];
    afterEach(async () => Promise.all(stores.splice(0).map(disposeStore)));

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
