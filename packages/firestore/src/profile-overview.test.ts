import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FirestoreProfileVoiceOverviewRepository } from './profile-overview.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore profile voice overview', () => {
  it('counts every sample, returns the latest five owned imports, and decodes profile fields', async () => {
    const store = emulatorStore();
    const agentId = randomUUID();
    try {
      await store.doc('agents', agentId).set({ id: agentId });
      const batch = store.db.batch();
      for (let index = 0; index < 125; index++) {
        const id = randomUUID();
        batch.set(store.doc('writingSamples', id), {
          id,
          context: index < 40 ? 'auto:mail' : index < 90 ? 'upload:takeout' : 'seed',
        });
      }
      for (let index = 0; index < 8; index++) {
        const id = randomUUID();
        batch.set(store.doc('importSources', id), {
          id,
          agentId,
          source: `voice-samples-${index}`,
          status: 'done',
          updatedAt: new Date(Date.UTC(2026, 8, index + 1)),
          itemsTotal: 20,
          itemsProcessed: index,
          memoriesSaved: index,
          taskId: null,
          error: null,
        });
      }
      const foreignId = randomUUID();
      batch.set(store.doc('importSources', foreignId), {
        id: foreignId,
        agentId: 'other-agent',
        source: 'voice-samples-foreign',
        updatedAt: new Date('2026-10-01T00:00:00Z'),
      });
      batch.set(store.doc('voiceProfile', '1'), {
        id: 1,
        description: 'Plainspoken',
        dos: ['short sentences', 5],
        donts: ['formal greeting'],
        signature: 'B',
      });
      await batch.commit();

      const result = await new FirestoreProfileVoiceOverviewRepository(store).load();
      expect(result.voiceStats).toEqual({ total: 125, auto: 40, uploaded: 50 });
      expect(result.voiceProfile).toEqual({
        description: 'Plainspoken',
        dos: ['short sentences'],
        donts: ['formal greeting'],
        signature: 'B',
      });
      expect(result.voiceImports.map((row) => row.source)).toEqual([
        'voice-samples-7',
        'voice-samples-6',
        'voice-samples-5',
        'voice-samples-4',
        'voice-samples-3',
      ]);
      expect(result.voiceImports[0]).toMatchObject({ itemsTotal: 20, itemsProcessed: 7 });
    } finally {
      await disposeStore(store);
    }
  });

  it('rejects ambiguous agent ownership', async () => {
    const store = emulatorStore();
    try {
      for (const id of [randomUUID(), randomUUID()]) await store.doc('agents', id).set({ id });
      await expect(new FirestoreProfileVoiceOverviewRepository(store).load()).rejects.toThrow(
        'exactly one configured agent',
      );
    } finally {
      await disposeStore(store);
    }
  });
});
