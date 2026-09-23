import { afterEach, describe, expect, it } from 'vitest';
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
  },
);
