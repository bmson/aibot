import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { FirestorePrivacyErasureRepository } from './privacy-erasure.js';
import { FirestoreProfileOverviewRepository } from './profile-full-overview.js';
import { FirestoreProfileMemoryHubRepository } from './profile-memory-hub.js';
import { FirestoreProfileVoiceOverviewRepository } from './profile-overview.js';
import { disposeStore, emulatorStore } from './test-store.js';

type Reader = 'voice' | 'hub' | 'full';

function read(store: ReturnType<typeof emulatorStore>, reader: Reader): Promise<unknown> {
  switch (reader) {
    case 'voice':
      return new FirestoreProfileVoiceOverviewRepository(store).load();
    case 'hub':
      return new FirestoreProfileMemoryHubRepository(store).load();
    case 'full':
      return new FirestoreProfileOverviewRepository(store).load();
  }
}

async function seededStore() {
  const now = new Date('2026-09-22T12:00:00Z');
  const store = emulatorStore(() => now);
  const agentId = randomUUID();
  const ownerId = randomUUID();
  const memoryId = randomUUID();
  const sampleId = randomUUID();
  await Promise.all([
    store.doc('agents', agentId).set({ id: agentId }),
    store.doc('contacts', ownerId).set({
      id: ownerId,
      name: 'Owner',
      trust: 'owner',
      aliases: [],
      relationship: '',
    }),
    store.doc('memories', memoryId).set({
      id: memoryId,
      agentId,
      contentHash: `hash-${memoryId}`,
      category: 'knowledge',
      subjectContactId: ownerId,
      content: 'Private owner fact',
      kind: 'fact',
      domain: 'identity',
      confidence: '1.00',
      importance: 5,
      pinned: true,
      ownerConfirmed: true,
      quarantined: false,
      expiresAt: null,
      lastConsolidatedAt: now,
      originTrust: 'owner',
      sourceTaskId: null,
      validFrom: null,
      validUntil: null,
      createdAt: now,
    }),
    store.doc('writingSamples', sampleId).set({
      id: sampleId,
      agentId,
      text: 'Private owner writing',
      context: 'upload:archive',
    }),
    store.doc('voiceProfile', '1').set({
      id: 1,
      description: 'Private voice',
      dos: [],
      donts: [],
      signature: '',
    }),
    store.doc('ownerCards', agentId).set({
      agentId,
      content: 'Private owner card',
      compiledAt: now,
    }),
  ]);
  return { store, agentId, memoryId, sampleId };
}

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Profile overview erasure fences', () => {
  for (const reader of ['voice', 'hub', 'full'] as const) {
    it(`${reader} refuses a read while erasure is active`, async () => {
      const { store, agentId } = await seededStore();
      try {
        await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
        await expect(read(store, reader)).rejects.toThrow('Privacy erasure is in progress');
      } finally {
        await disposeStore(store);
      }
    });

    it(`${reader} rejects data when erasure completes during its read`, async () => {
      const { store, agentId, memoryId, sampleId } = await seededStore();
      const erasure = new FirestorePrivacyErasureRepository(store);
      const originalDoc = store.doc.bind(store);
      const triggerRead = reader === 'full' ? 4 : 2;
      let fenceReads = 0;
      const spy = vi.spyOn(store, 'doc').mockImplementation((collection, id) => {
        const ref = originalDoc(collection, id);
        if (collection === 'privacyErasureJobs' && id === agentId) {
          const get = ref.get.bind(ref);
          vi.spyOn(ref, 'get').mockImplementation(async () => {
            fenceReads += 1;
            if (fenceReads === triggerRead) {
              await erasure.erase();
              await erasure.complete();
            }
            return get();
          });
        }
        return ref;
      });
      try {
        await expect(read(store, reader)).rejects.toThrow('Privacy erasure changed during read');
        expect(fenceReads).toBe(triggerRead);
        expect((await originalDoc('privacyErasureJobs', agentId).get()).get('status')).toBe(
          'complete',
        );
        expect((await originalDoc('memories', memoryId).get()).exists).toBe(false);
        expect((await originalDoc('writingSamples', sampleId).get()).exists).toBe(false);
      } finally {
        spy.mockRestore();
        await disposeStore(store);
      }
    });
  }
});
