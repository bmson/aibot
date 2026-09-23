import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  FirestoreProfileMemoryHubRepository,
  loadProfileHubSource,
  profileMemoryHubFromSource,
} from './profile-memory-hub.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore profile Memory hub', () => {
  it('keeps exact health counts beyond the inbox limit and scopes agent-owned state', async () => {
    const now = new Date('2026-09-22T12:00:00Z');
    const store = emulatorStore(() => now);
    const agentId = randomUUID();
    const ownerId = randomUUID();
    const personId = randomUUID();
    try {
      await store.doc('agents', agentId).set({ id: agentId });
      let batch = store.db.batch();
      batch.set(store.doc('contacts', ownerId), {
        id: ownerId,
        name: 'Owner',
        aliases: [],
        relationship: '',
        trust: 'owner',
      });
      batch.set(store.doc('contacts', personId), {
        id: personId,
        name: 'Person',
        aliases: ['P'],
        relationship: 'friend',
        trust: 'known',
      });
      for (let index = 0; index < 510; index++) {
        if (index === 400) {
          await batch.commit();
          batch = store.db.batch();
        }
        const id = randomUUID();
        batch.set(store.doc('memories', id), {
          id,
          agentId,
          category: 'knowledge',
          quarantined: true,
          expiresAt: null,
          createdAt: new Date(now.getTime() - index * 1000),
          content: `Review ${index}`,
          kind: 'fact',
          domain: null,
          confidence: '0.70',
          importance: 3,
          ownerConfirmed: false,
          pinned: false,
          lastConsolidatedAt: null,
          originTrust: 'unknown',
          sourceTaskId: null,
          validFrom: null,
          validUntil: null,
        });
      }
      for (const [index, values] of [
        { subjectContactId: ownerId, ownerConfirmed: true, lastConsolidatedAt: now },
        { subjectContactId: personId, ownerConfirmed: false, lastConsolidatedAt: null },
      ].entries()) {
        const id = randomUUID();
        batch.set(store.doc('memories', id), {
          id,
          agentId,
          category: 'knowledge',
          quarantined: false,
          expiresAt: null,
          createdAt: now,
          content: `Usable ${index}`,
          kind: 'fact',
          domain: null,
          confidence: '1.00',
          importance: 3,
          pinned: false,
          originTrust: 'owner',
          sourceTaskId: null,
          validFrom: null,
          validUntil: null,
          ...values,
        });
      }
      const foreignId = randomUUID();
      batch.set(store.doc('memories', foreignId), {
        id: foreignId,
        agentId: 'foreign',
        category: 'knowledge',
        quarantined: true,
        expiresAt: null,
      });
      const expiredId = randomUUID();
      batch.set(store.doc('memories', expiredId), {
        id: expiredId,
        agentId,
        category: 'knowledge',
        quarantined: true,
        expiresAt: new Date('2026-09-21T00:00:00Z'),
      });
      for (const [index, verdict] of ['helpful', 'not_helpful'].entries()) {
        const id = randomUUID();
        batch.set(store.doc('recallFeedback', id), {
          id,
          agentId,
          verdict,
          createdAt: new Date(now.getTime() - index * 1000),
        });
      }
      for (const [id, feedbackAgentId, createdAt] of [
        [randomUUID(), agentId, new Date('2026-01-01T00:00:00Z')],
        [randomUUID(), 'foreign', now],
      ] as const) {
        batch.set(store.doc('recallFeedback', id), {
          id,
          agentId: feedbackAgentId,
          verdict: 'not_helpful',
          createdAt,
        });
      }
      const taskId = randomUUID();
      batch.set(store.doc('tasks', taskId), {
        id: taskId,
        agentId,
        status: 'running',
        progress: 'Organizing',
        trigger: { payload: { job: 'memory.consolidate' } },
        createdAt: now,
        updatedAt: now,
      });
      batch.set(store.doc('ownerCards', agentId), {
        agentId,
        content: '  ',
        compiledAt: now,
      });
      await batch.commit();

      const result = await new FirestoreProfileMemoryHubRepository(store).load();
      // The bounded projection must preserve the complete preexisting hub
      // result, including ordering and fields outside the health counts.
      expect(result).toEqual(profileMemoryHubFromSource(await loadProfileHubSource(store)));
      expect(result.quarantined).toHaveLength(100);
      expect(result.memoryHealth).toEqual({
        totalUsable: 2,
        notYetOrganized: 1,
        awaitingReview: 510,
        ownerConfirmed: 1,
        lastOrganizedAt: now,
      });
      expect(result.recallFeedback).toEqual({
        rated: 2,
        helpful: 1,
        notHelpful: 1,
        lastRatedAt: now,
        windowDays: 90,
      });
      expect(result.ownerFactCount).toBe(1);
      expect(result.peopleCount).toBe(1);
      expect(result.card).toEqual({ compiledAt: now, empty: true });
      expect(result.latestOrganizer).toEqual({
        id: taskId,
        status: 'running',
        progress: 'Organizing',
        updatedAt: now,
      });
    } finally {
      await disposeStore(store);
    }
  });
});
