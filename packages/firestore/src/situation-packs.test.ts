import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FirestoreSituationPackReadRepository } from './situation-packs.js';
import { disposeStore, emulatorStore } from './test-store.js';

const now = new Date('2026-09-23T12:00:00.000Z');

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore situation pack reads', () => {
  it('projects only owner packs and sources, detects linked changes, and honors erasure', async () => {
    const store = emulatorStore(() => now);
    try {
      const owner = randomUUID();
      const other = randomUUID();
      const packId = randomUUID();
      const foreignPackId = randomUUID();
      const commitmentId = randomUUID();
      const foreignCommitmentId = randomUUID();
      const cardId = randomUUID();
      const revisionId = randomUUID();
      const earlier = new Date('2026-09-22T12:00:00.000Z');
      await Promise.all([
        store.doc('situationPacks', packId).set({
          id: packId,
          agentId: owner,
          creationKey: 'trip',
          title: 'Trip',
          createdAt: earlier,
          updatedAt: now,
          version: 2,
          archived: false,
          data: {
            items: [
              {
                id: 'booking',
                title: 'Check booking',
                details: '',
                lane: 'plan',
                dependsOn: [],
                needsReview: false,
                source: { kind: 'commitment', id: commitmentId },
                snapshot: {
                  revision: earlier.toISOString(),
                  state: 'open',
                  title: 'Old booking',
                  details: '',
                },
              },
              {
                id: 'travel',
                title: 'Arrange travel',
                details: '',
                lane: 'plan',
                dependsOn: ['booking'],
                needsReview: false,
                source: null,
                snapshot: null,
              },
              {
                id: 'ticket',
                title: 'Use saved ticket',
                details: '',
                lane: 'plan',
                dependsOn: [],
                needsReview: false,
                source: { kind: 'card', id: cardId },
                snapshot: null,
              },
              {
                id: 'foreign_link',
                title: 'Untrusted link',
                details: '',
                lane: 'plan',
                dependsOn: [],
                needsReview: false,
                source: { kind: 'commitment', id: foreignCommitmentId },
                snapshot: null,
              },
            ],
            decisions: [],
          },
        }),
        store.doc('situationPacks', foreignPackId).set({
          id: foreignPackId,
          agentId: other,
          creationKey: 'secret',
          title: 'Secret',
          createdAt: earlier,
          updatedAt: now,
          version: 1,
          archived: false,
          data: { items: [], decisions: [] },
        }),
        store.doc('commitments', commitmentId).set({
          id: commitmentId,
          agentId: owner,
          title: 'New booking',
          status: 'open',
          updatedAt: now,
          kind: 'waiting_on',
          details: '',
          nextAction: '',
          dueAt: null,
          resolution: null,
        }),
        store.doc('commitments', foreignCommitmentId).set({
          id: foreignCommitmentId,
          agentId: other,
          title: 'Foreign secret',
          status: 'open',
          updatedAt: now,
          kind: 'i_owe',
        }),
        store.doc('generatedCards', cardId).set({
          id: cardId,
          agentId: owner,
          updatedAt: now,
          status: 'active',
          expiresAt: null,
          currentRevisionId: revisionId,
        }),
        store.doc('generatedCardRevisions', revisionId).set({
          id: revisionId,
          cardId,
          spec: {
            version: 1,
            title: 'Saved card',
            icon: 'generic',
            accent: 'mint',
            accessibilityLabel: 'Saved card',
            sourceLabel: 'test',
            facts: [
              { id: 'public', value: 'Visible', source: 'test' },
              { id: 'private', value: 'Never expose me', source: 'test', sensitive: true },
            ],
            blocks: [{ type: 'facts', factIds: ['public', 'private'] }],
            actions: [],
            refreshable: false,
          },
        }),
      ]);
      const repository = new FirestoreSituationPackReadRepository(store);
      const result = await repository.overview(owner);
      expect(result.packs.map((pack) => pack.id)).toEqual([packId]);
      expect(result.packs[0]?.changes).toMatchObject([
        { itemId: 'booking', after: { title: 'New booking' } },
        { itemId: 'ticket', after: { title: 'Saved card', details: 'public: Visible' } },
        { itemId: 'foreign_link', after: { state: 'unavailable' } },
      ]);
      expect(result.packs[0]?.affectedIds).toEqual(['booking', 'travel', 'ticket', 'foreign_link']);
      expect(result.sources).toMatchObject([
        { id: cardId, title: 'Saved card' },
        { id: commitmentId, title: 'New booking', lane: 'waiting_on' },
      ]);
      expect(JSON.stringify(result)).not.toContain('Foreign secret');
      expect(JSON.stringify(result)).not.toContain('Never expose me');
      await store.doc('privacyErasureJobs', owner).set({
        agentId: owner,
        status: 'active',
        generation: randomUUID(),
      });
      await expect(repository.overview(owner)).rejects.toThrow('Privacy erasure');
    } finally {
      await disposeStore(store);
    }
  });
});
