import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';
import { FirestoreWorkspaceImprovementRepository } from './workspace-improvements.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore mobile workspace improvements',
  () => {
    let store: InstallationStore;
    let repository: FirestoreWorkspaceImprovementRepository;
    const agentId = randomUUID();

    beforeEach(() => {
      store = emulatorStore();
      repository = new FirestoreWorkspaceImprovementRepository(store);
    });
    afterEach(async () => disposeStore(store));

    async function seed(id: string, patch: Record<string, unknown> = {}, documentId = id) {
      await store.doc('improvementProposals', documentId).set({
        id,
        agentId,
        status: 'open',
        kind: 'model_role',
        title: 'Change draft model',
        rationale: 'Retries cost too much',
        change: { suggestion: 'Choose another model' },
        evidenceIds: ['task-one'],
        createdAt: new Date('2026-09-01T00:00:00Z'),
        ...patch,
      });
    }

    it('returns newest 100 open owner proposals without foreign or dismissed rows', async () => {
      const batch = store.db.batch();
      for (let index = 0; index < 105; index++) {
        const id = `proposal-${String(index).padStart(3, '0')}`;
        batch.set(store.doc('improvementProposals', id), {
          id,
          agentId,
          status: 'open',
          kind: 'model_role',
          title: 'Change draft model',
          rationale: 'Retries cost too much',
          change: { suggestion: 'Choose another model' },
          evidenceIds: ['task-one'],
          createdAt: new Date(Date.UTC(2026, 8, 1, 0, index)),
        });
      }
      batch.set(store.doc('improvementProposals', 'foreign'), {
        id: 'foreign',
        agentId: 'another-owner',
        status: 'open',
        kind: 'note',
        title: 'Foreign',
        rationale: '',
        change: {},
        evidenceIds: [],
        createdAt: new Date('2026-12-01'),
      });
      await batch.commit();
      await seed('dismissed', { status: 'dismissed', createdAt: new Date('2026-12-01') });

      const rows = await repository.listOpen(agentId);
      expect(rows).toHaveLength(100);
      expect(rows[0]?.id).toBe('proposal-104');
      expect(rows.at(-1)?.id).toBe('proposal-005');
      expect((await repository.listOpen('another-owner')).map((row) => row.id)).toEqual([
        'foreign',
      ]);
    });

    it('fails closed on malformed records and active privacy erasure', async () => {
      await seed('wrong-id', {}, 'different-document');
      await expect(repository.listOpen(agentId)).rejects.toThrow(
        'Invalid owner improvement document',
      );
      await store.doc('improvementProposals', 'different-document').delete();
      await seed('bad-evidence', { evidenceIds: [42] });
      await expect(repository.listOpen(agentId)).rejects.toThrow(
        'Invalid open improvement document',
      );
      await store.doc('improvementProposals', 'bad-evidence').delete();
      await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
      await expect(repository.listOpen(agentId)).rejects.toThrow('Privacy erasure is in progress');
    });

    it('rejects owner scans beyond the cap instead of returning a partial top 100', async () => {
      for (let offset = 0; offset < 2_001; offset += 500) {
        const batch = store.db.batch();
        for (let index = offset; index < Math.min(offset + 500, 2_001); index++) {
          const id = `old-${index}`;
          batch.set(store.doc('improvementProposals', id), {
            id,
            agentId,
            status: 'dismissed',
          });
        }
        await batch.commit();
      }
      await expect(repository.listOpen(agentId)).rejects.toThrow(
        'Owner improvements exceed the mobile workspace scan limit',
      );
    });
  },
);
