import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreImportOverviewRepository } from './import-overview.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore mobile import overview without PostgreSQL',
  () => {
    let store: InstallationStore;
    let repository: FirestoreImportOverviewRepository;
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const now = new Date('2026-09-22T12:00:00Z');

    beforeEach(async () => {
      store = emulatorStore(() => now);
      repository = new FirestoreImportOverviewRepository(store, agentId);
      await store.doc('agents', agentId).set({ id: agentId });
      await store.doc('agents', otherAgentId).set({ id: otherAgentId });
    });

    afterEach(async () => disposeStore(store));

    const importSource = (id: string, source: string, updatedAt: Date, ownerId = agentId) => ({
      id,
      agentId: ownerId,
      createdAt: now,
      updatedAt,
      source,
      workspacePath: `import/${source}.txt`,
      kind: 'text',
      status: 'done',
      taskId: null,
      itemsTotal: 1,
      itemsProcessed: 1,
      memoriesSaved: 1,
      memoriesQuarantined: 0,
      error: null,
    });

    const memory = (id: string, source: string | null, ownerId = agentId, quarantined = true) => ({
      id,
      agentId: ownerId,
      category: 'knowledge',
      quarantined,
      expiresAt: new Date('2020-01-01T00:00:00Z'),
      createdAt: now,
      content: `memory ${id}`,
      kind: 'fact',
      domain: null,
      confidence: '1.00',
      importance: 1,
      ownerConfirmed: false,
      pinned: false,
      lastConsolidatedAt: null,
      originTrust: 'owner',
      sourceTaskId: null,
      validFrom: null,
      validUntil: null,
      source,
    });

    it('keeps exact owner quarantine counts and source ordering without reading PostgreSQL', async () => {
      const recent = importSource('recent-source', 'recent', now);
      const old = importSource('old-source', 'old', new Date(now.getTime() - 10_000));
      const voice = importSource('voice-source', 'voice-samples-upload', new Date(0));
      const foreign = importSource('foreign-source', 'foreign', now, otherAgentId);
      const batch = store.db.batch();
      for (const row of [recent, old, voice, foreign])
        batch.set(store.doc('importSources', row.id), row);

      const quarantinedRecent = memory(randomUUID(), 'recent');
      const quarantinedRecent2 = memory(randomUUID(), 'recent');
      const quarantinedVoice = memory(randomUUID(), 'voice-samples-upload');
      const noSource = memory(randomUUID(), null);
      const usable = memory(randomUUID(), 'recent', agentId, false);
      const foreignMemory = memory(randomUUID(), 'foreign', otherAgentId);
      for (const row of [
        quarantinedRecent,
        quarantinedRecent2,
        quarantinedVoice,
        noSource,
        usable,
        foreignMemory,
      ])
        batch.set(store.doc('memories', row.id), row);
      await batch.commit();

      await expect(repository.load()).resolves.toEqual({
        sources: [recent, old, voice],
        quarantineBySource: { recent: 2, 'voice-samples-upload': 1 },
      });
    });

    it('rejects a repository configured for another agent', async () => {
      const missingRepository = new FirestoreImportOverviewRepository(store, randomUUID());
      await expect(missingRepository.load()).rejects.toThrow('Configured Firestore agent');
    });
  },
);
