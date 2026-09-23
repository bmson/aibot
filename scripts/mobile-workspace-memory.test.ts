import { randomUUID } from 'node:crypto';
import { FirestoreProfileOverviewRepository } from '@assistant/firestore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getProfileOverview } from '../packages/application/src/profile.js';
import { projectMobileWorkspaceMemory } from '../packages/application/src/workspace-memory.js';
import type { InstallationStore } from '../packages/firestore/src/store.js';
import { disposeStore, emulatorStore } from '../packages/firestore/src/test-store.js';

const now = new Date('2026-09-22T12:00:00.000Z');

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore mobile workspace memory projection',
  () => {
    let store: InstallationStore;

    beforeEach(() => {
      store = emulatorStore(() => now);
    });

    afterEach(async () => disposeStore(store));

    it('returns the full mobile memory shape without foreign or expired facts', async () => {
      const agentId = randomUUID();
      const ownerId = randomUUID();
      const personId = randomUUID();
      const ownerFactId = randomUUID();
      const reviewId = randomUUID();
      const organizedAt = new Date('2026-09-21T09:00:00.000Z');
      const batch = store.db.batch();
      batch.set(store.doc('agents', agentId), { id: agentId });
      batch.set(store.doc('contacts', ownerId), {
        id: ownerId,
        name: 'Owner',
        aliases: ['B'],
        relationship: '',
        trust: 'owner',
      });
      batch.set(store.doc('contacts', personId), {
        id: personId,
        name: 'Alex',
        aliases: ['A'],
        relationship: 'friend',
        trust: 'known',
      });
      const memory = (id: string, subjectContactId: string) => ({
        id,
        agentId,
        subjectContactId,
        category: 'knowledge',
        kind: 'fact',
        content: `Fact ${id}`,
        confidence: '0.90',
        importance: 5,
        domain: 'work',
        pinned: false,
        ownerConfirmed: false,
        quarantined: false,
        expiresAt: null,
        originTrust: 'owner',
        sourceTaskId: null,
        lastConsolidatedAt: null,
        validFrom: null,
        validUntil: null,
        createdAt: now,
      });
      batch.set(store.doc('memories', ownerFactId), {
        ...memory(ownerFactId, ownerId),
        pinned: true,
        ownerConfirmed: true,
        lastConsolidatedAt: organizedAt,
      });
      const personFactId = randomUUID();
      batch.set(store.doc('memories', personFactId), memory(personFactId, personId));
      batch.set(store.doc('memories', reviewId), {
        ...memory(reviewId, ownerId),
        quarantined: true,
      });
      const expiredId = randomUUID();
      batch.set(store.doc('memories', expiredId), {
        ...memory(expiredId, ownerId),
        expiresAt: new Date('2020-01-01T00:00:00.000Z'),
      });
      const foreignId = randomUUID();
      batch.set(store.doc('memories', foreignId), {
        ...memory(foreignId, ownerId),
        agentId: 'foreign',
      });
      const sampleId = randomUUID();
      batch.set(store.doc('writingSamples', sampleId), {
        id: sampleId,
        agentId,
        context: 'upload:sample',
      });
      batch.set(store.doc('ownerCards', agentId), {
        agentId,
        content: 'Compiled owner card',
        compiledAt: now,
      });
      const organizerId = randomUUID();
      batch.set(store.doc('tasks', organizerId), {
        id: organizerId,
        agentId,
        trigger: { payload: { job: 'memory.consolidate' } },
        status: 'completed',
        progress: 'organized',
        createdAt: now,
        updatedAt: now,
      });
      await batch.commit();

      const result = projectMobileWorkspaceMemory(
        await getProfileOverview(new FirestoreProfileOverviewRepository(store)),
      );
      expect(result).toEqual({
        ownerName: 'Owner',
        ownerContactId: ownerId,
        health: {
          totalUsable: 2,
          notYetOrganized: 1,
          awaitingReview: 1,
          ownerConfirmed: 1,
          lastOrganizedAt: organizedAt.toISOString(),
        },
        facts: [
          {
            id: ownerFactId,
            content: `Fact ${ownerFactId}`,
            kind: 'fact',
            domain: 'work',
            ownerConfirmed: true,
            pinned: true,
            importance: 5,
            createdAt: now.toISOString(),
          },
        ],
        awaitingReview: [
          {
            id: reviewId,
            content: `Fact ${reviewId}`,
            kind: 'fact',
            domain: 'work',
            ownerConfirmed: false,
            pinned: false,
            importance: 5,
            createdAt: now.toISOString(),
          },
        ],
        peopleCount: 1,
        people: [
          {
            id: personId,
            name: 'Alex',
            aliases: ['A'],
            relationship: 'friend',
            trust: 'known',
            factCount: 1,
          },
        ],
        card: { content: 'Compiled owner card', compiledAt: now.toISOString() },
        voiceStats: { total: 1, auto: 0, uploaded: 1 },
        latestOrganizer: {
          id: organizerId,
          status: 'completed',
          progress: 'organized',
          updatedAt: now.toISOString(),
        },
      });
      expect(JSON.stringify(result)).not.toContain(foreignId);
      expect(JSON.stringify(result)).not.toContain(expiredId);
    });

    it('fails closed when no configured owner agent exists', async () => {
      await expect(
        getProfileOverview(new FirestoreProfileOverviewRepository(store)),
      ).rejects.toThrow('exactly one configured agent');
    });
  },
);
