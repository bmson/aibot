import { createHash, randomUUID } from 'node:crypto';
import type { EmbeddingSpace, Records } from '@assistant/persistence';
import { FieldValue } from '@google-cloud/firestore';
import { describe, expect, it } from 'vitest';
import { embeddingSpaceKey } from './memory.js';
import { FirestoreMemoryConsolidationRepository } from './memory-consolidation.js';
import { encodeRecord, type InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

const space: EmbeddingSpace = {
  provider: 'test',
  model: 'consolidation',
  dimensions: 2,
  revision: 'v1',
};
const now = new Date('2026-09-23T12:00:00.000Z');

function memory(
  id: string,
  agentId: string,
  subjectContactId: string | null,
  changes: Partial<Records['memories']> = {},
): Records['memories'] {
  return {
    id,
    agentId,
    subjectContactId,
    createdAt: new Date('2026-09-20T12:00:00.000Z'),
    expiresAt: null,
    embedding: [1, 0],
    sourceTaskId: null,
    kind: 'fact',
    confidence: '0.70',
    contentHash: createHash('sha256').update(id).digest('hex'),
    goalId: null,
    originTrust: 'assistant',
    category: 'knowledge',
    content: `Fact ${id}`,
    importance: 3,
    quarantined: false,
    domain: null,
    validFrom: null,
    validUntil: null,
    supersededById: null,
    ownerConfirmed: false,
    pinned: false,
    source: 'test',
    lastAccessedAt: null,
    lastConsolidatedAt: null,
    ...changes,
  };
}

async function seed(store: InstallationStore, row: Records['memories']) {
  await store.doc('memories', row.id).set(
    encodeRecord({
      ...row,
      embedding: FieldValue.vector(row.embedding ?? [1, 0]),
      embeddingSpace: embeddingSpaceKey(space),
    }),
  );
}

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore memory consolidation repository',
  () => {
    it('selects only live owner facts, stamps standalones, and rotates a bounded person window', async () => {
      const store = emulatorStore(() => now);
      try {
        await store.doc('agents', 'owner').set({ id: 'owner' });
        const alone = memory(randomUUID(), 'owner', null);
        const singleton = memory(randomUUID(), 'owner', 'one');
        const first = memory(randomUUID(), 'owner', 'person');
        const second = memory(randomUUID(), 'owner', 'person');
        await Promise.all([
          seed(store, alone),
          seed(store, singleton),
          seed(store, first),
          seed(store, second),
          seed(store, memory(randomUUID(), 'other', 'person')),
          seed(store, memory(randomUUID(), 'owner', 'person', { quarantined: true })),
          seed(
            store,
            memory(randomUUID(), 'owner', 'person', { expiresAt: new Date('2026-09-22') }),
          ),
        ]);
        const repo = new FirestoreMemoryConsolidationRepository(store, space);
        const batch = await repo.candidates('owner');
        expect(batch.standalone.map((row) => row.id).sort()).toEqual(
          [alone.id, singleton.id].sort(),
        );
        expect(batch.window?.subjectContactId).toBe('person');
        expect(batch.window?.facts.map((row) => row.id).sort()).toEqual(
          [first.id, second.id].sort(),
        );
        expect(await repo.stampStandalone('owner', batch.standalone)).toBe(2);
        expect(
          (await store.doc('memories', alone.id).get()).get('lastConsolidatedAt').toDate(),
        ).toEqual(now);
        expect(
          (await store.doc('memories', singleton.id).get()).get('lastConsolidatedAt').toDate(),
        ).toEqual(now);
      } finally {
        await disposeStore(store);
      }
    });

    it('atomically merges and supersedes, and rejects stale or foreign decisions', async () => {
      const store = emulatorStore(() => now);
      try {
        await store.doc('agents', 'owner').set({ id: 'owner' });
        const first = memory(randomUUID(), 'owner', 'person');
        const second = memory(randomUUID(), 'owner', 'person');
        await seed(store, first);
        await seed(store, second);
        const repo = new FirestoreMemoryConsolidationRepository(store, space);
        const facts = (await repo.candidates('owner')).window?.facts;
        expect(facts).toHaveLength(2);
        const mergedId = randomUUID();
        const unified = 'The same person has two facts merged faithfully.';
        const review = {
          agentId: 'owner',
          subjectContactId: 'person',
          facts: facts ?? [],
          retirements: [],
          domainFixes: [],
          timeline: [],
          merges: [
            {
              id: mergedId,
              content: unified,
              contentHash: createHash('sha256').update(unified).digest('hex'),
              embedding: [1, 0],
              kind: 'fact',
              confidence: '0.70',
              importance: 3,
              domain: 'work',
              sourceTaskId: null,
              memberIds: [first.id, second.id],
            },
          ],
        };
        await expect(repo.applyReview({ ...review, agentId: 'other' })).rejects.toThrow();
        expect((await store.doc('memories', mergedId).get()).exists).toBe(false);
        expect(await repo.applyReview(review)).toEqual({
          retired: expect.arrayContaining([first.id, second.id]),
          merged: [mergedId],
          domainsAssigned: [],
        });
        expect((await store.doc('memories', first.id).get()).get('supersededById')).toBe(mergedId);
        expect((await store.doc('memories', second.id).get()).get('supersededById')).toBe(mergedId);
        expect((await store.doc('memories', mergedId).get()).get('content')).toBe(unified);
        await expect(repo.applyReview(review)).rejects.toThrow('changed');
        expect(
          (await store.doc('memoryContentHashes', review.merges[0]?.contentHash ?? '').get()).get(
            'memoryId',
          ),
        ).toBe(mergedId);
      } finally {
        await disposeStore(store);
      }
    });

    it('commits domain and timeline updates with the review stamp', async () => {
      const store = emulatorStore(() => now);
      try {
        await store.doc('agents', 'owner').set({ id: 'owner' });
        const first = memory(randomUUID(), 'owner', 'person');
        const second = memory(randomUUID(), 'owner', 'person');
        await seed(store, first);
        await seed(store, second);
        const repo = new FirestoreMemoryConsolidationRepository(store, space);
        const facts = (await repo.candidates('owner')).window?.facts ?? [];
        const validFrom = new Date('2024-01-01T00:00:00.000Z');
        expect(
          await repo.applyReview({
            agentId: 'owner',
            subjectContactId: 'person',
            facts,
            retirements: [],
            merges: [],
            domainFixes: [{ id: first.id, domain: 'work' }],
            timeline: [{ id: first.id, validFrom }],
          }),
        ).toEqual({ retired: [], merged: [], domainsAssigned: [first.id] });
        const changed = await store.doc('memories', first.id).get();
        expect(changed.get('domain')).toBe('work');
        expect(changed.get('validFrom').toDate()).toEqual(validFrom);
        expect(changed.get('lastConsolidatedAt').toDate()).toEqual(now);
      } finally {
        await disposeStore(store);
      }
    });

    it('preserves owner-confirmed precedence and erased content', async () => {
      const store = emulatorStore(() => now);
      try {
        await store.doc('agents', 'owner').set({ id: 'owner' });
        const confirmed = memory(randomUUID(), 'owner', 'person', { ownerConfirmed: true });
        const unconfirmed = memory(randomUUID(), 'owner', 'person');
        await seed(store, confirmed);
        await seed(store, unconfirmed);
        const repo = new FirestoreMemoryConsolidationRepository(store, space);
        const facts = (await repo.candidates('owner')).window?.facts ?? [];
        const decision = {
          agentId: 'owner',
          subjectContactId: 'person',
          facts,
          retirements: [{ id: confirmed.id, supersededById: unconfirmed.id }],
          merges: [],
          domainFixes: [],
          timeline: [],
        };
        await expect(repo.applyReview(decision)).rejects.toThrow(
          'Invalid consolidation retirement',
        );
        expect((await store.doc('memories', confirmed.id).get()).get('supersededById')).toBeNull();
        await store
          .doc('memoryTombstones', confirmed.contentHash)
          .set({ contentHash: confirmed.contentHash });
        await expect(repo.applyReview({ ...decision, retirements: [] })).rejects.toThrow('erased');
        expect(
          (await store.doc('memories', unconfirmed.id).get()).get('lastConsolidatedAt'),
        ).toBeNull();
      } finally {
        await disposeStore(store);
      }
    });

    it('holds the privacy erasure fence across candidate reads and writes', async () => {
      const store = emulatorStore(() => now);
      try {
        await store.doc('agents', 'owner').set({ id: 'owner' });
        const first = memory(randomUUID(), 'owner', 'person');
        const second = memory(randomUUID(), 'owner', 'person');
        await seed(store, first);
        await seed(store, second);
        const repo = new FirestoreMemoryConsolidationRepository(store, space);
        const facts = (await repo.candidates('owner')).window?.facts ?? [];
        await store.doc('privacyErasureJobs', 'owner').set({ agentId: 'owner', status: 'active' });
        await expect(repo.candidates('owner')).rejects.toThrow('Privacy erasure');
        await expect(
          repo.applyReview({
            agentId: 'owner',
            subjectContactId: 'person',
            facts,
            retirements: [{ id: first.id, supersededById: second.id }],
            merges: [],
            domainFixes: [],
            timeline: [],
          }),
        ).rejects.toThrow('Privacy erasure');
        expect((await store.doc('memories', first.id).get()).get('supersededById')).toBeNull();
      } finally {
        await disposeStore(store);
      }
    });

    it('moves past a full reviewed window and refuses to stamp a newly non-singleton subject', async () => {
      const store = emulatorStore(() => now);
      try {
        await store.doc('agents', 'owner').set({ id: 'owner' });
        const ids = Array.from({ length: 65 }, () => randomUUID());
        for (const id of ids) await seed(store, memory(id, 'owner', 'large'));
        const alone = memory(randomUUID(), 'owner', 'new-person');
        await seed(store, alone);
        const repo = new FirestoreMemoryConsolidationRepository(store, space);
        const first = await repo.candidates('owner');
        expect(first.window?.facts).toHaveLength(60);
        await repo.applyReview({
          agentId: 'owner',
          subjectContactId: 'large',
          facts: first.window?.facts ?? [],
          retirements: [],
          merges: [],
          domainFixes: [],
          timeline: [],
        });
        const next = await repo.candidates('owner');
        expect(next.window?.facts.filter((row) => !row.lastConsolidatedAt)).toHaveLength(5);
        expect(next.standalone.map((row) => row.id)).toContain(alone.id);
        const standalone = next.standalone.find((row) => row.id === alone.id);
        if (!standalone) throw new Error('Expected standalone candidate');
        await seed(store, memory(randomUUID(), 'owner', 'new-person'));
        await expect(repo.stampStandalone('owner', [standalone])).rejects.toThrow(
          'subject changed',
        );
        expect((await store.doc('memories', alone.id).get()).get('lastConsolidatedAt')).toBeNull();
      } finally {
        await disposeStore(store);
      }
    });
  },
);
