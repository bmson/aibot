import { randomUUID } from 'node:crypto';
import type { EmbeddingSpace, Records } from '@assistant/persistence';
import { FieldValue } from '@google-cloud/firestore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreGraphRecallRepository } from './graph-recall.js';
import { FirestoreHistoryRecallRepository } from './history-recall.js';
import { embeddingSpaceKey, FirestoreMemoryRepository } from './memory.js';
import { FirestoreRecallMetricsRepository } from './recall-metrics.js';
import { encodeRecord, type InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

const space: EmbeddingSpace = {
  provider: 'test',
  model: 'recall',
  dimensions: 1536,
  revision: '1',
};
const vector = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0));
const now = new Date('2026-09-12T12:00:00Z');
const before = new Date(now.getTime() - 3600000);

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore private history and graph recall',
  () => {
    let store: InstallationStore;
    beforeEach(() => {
      store = emulatorStore(() => now);
    });
    afterEach(async () => {
      await disposeStore(store);
    });
    async function conversation(id: string, agentId = 'owner', trust = 'owner') {
      await store.doc('conversations', id).set({ id, agentId, trust });
    }
    async function message(id: string, conversationId: string, createdAt = before, revision = '1') {
      await store.doc('messages', id).set({
        id,
        conversationId,
        role: 'user',
        text: `History ${id}`,
        createdAt,
        embedding: FieldValue.vector(vector),
        embeddingSpace: embeddingSpaceKey({ ...space, revision }),
      });
    }
    const input = () => ({
      agentId: 'owner',
      embedding: vector,
      exclude: { conversationId: 'current', sinceCreatedAt: now },
      limit: 4,
    });

    it('retrieves only owned trusted history in the correct space outside the live window', async () => {
      await conversation('current');
      await conversation('other', 'foreign');
      await conversation('untrusted', 'owner', 'unknown');
      await message('old', 'current');
      await message('recent', 'current', now);
      await message('foreign', 'other');
      await message('tainted', 'untrusted');
      await message('different-model', 'current', before, '2');
      const repo = new FirestoreHistoryRecallRepository(store, space);
      expect((await repo.messages(input())).map((row) => row.id)).toEqual(['old']);
      expect(
        await repo.recentWindowStart({ agentId: 'owner', conversationId: 'other', size: 20 }),
      ).toBeNull();
      expect(
        await repo.recentWindowStart({ agentId: 'owner', conversationId: 'current', size: 1 }),
      ).toEqual(now);
      const anchor = (await repo.messages(input()))[0];
      if (!anchor) throw new Error('Missing anchor');
      await store.doc('conversations', 'current').update({ trust: 'unknown' });
      expect(
        await repo.neighborhood({ agentId: 'owner', anchor, radius: 1, exclude: input().exclude }),
      ).toEqual([]);
    });

    it('does not attach a foreign key message to an otherwise owned segment', async () => {
      await conversation('current');
      await conversation('foreign', 'foreign');
      await message('foreign-key', 'foreign');
      await store.doc('conversationSegments', 'segment').set({
        id: 'segment',
        agentId: 'owner',
        conversationId: 'current',
        startMessageId: 'foreign-key',
        endMessageId: 'foreign-key',
        summary: 'An owned summary',
        startedAt: before,
        endedAt: before,
        embedding: FieldValue.vector(vector),
        embeddingSpace: embeddingSpaceKey(space),
      });
      const repo = new FirestoreHistoryRecallRepository(store, space);
      const rows = await repo.segments(input());
      expect(rows).toHaveLength(1);
      expect(rows[0]?.keyMessage).toBeUndefined();
      await store.doc('conversations', 'current').update({ agentId: 'foreign' });
      expect(await repo.segments(input())).toEqual([]);
    });

    async function graphMemory(
      id: string,
      entityA: string,
      entityB: string,
      options: Partial<Records['memories']> = {},
    ) {
      const memory: Records['memories'] = {
        id,
        agentId: 'owner',
        content: `Fact ${id}`,
        contentHash: `hash-${id}`,
        createdAt: before,
        expiresAt: null,
        embedding: vector,
        sourceTaskId: null,
        kind: 'fact',
        confidence: '1',
        goalId: null,
        originTrust: 'owner',
        category: 'knowledge',
        importance: 3,
        quarantined: false,
        subjectContactId: null,
        domain: null,
        validFrom: null,
        validUntil: null,
        supersededById: null,
        ownerConfirmed: true,
        pinned: false,
        source: 'synthetic',
        lastAccessedAt: null,
        lastConsolidatedAt: null,
        ...options,
      };
      await new FirestoreMemoryRepository(store, space).save(memory);
      for (const entityId of [entityA, entityB])
        await store
          .doc('knowledgeGraphEntities', entityId)
          .set({ id: entityId, agentId: 'owner', label: entityId, preferredLabel: null });
      await store.doc('knowledgeGraphSources', id).set({
        memoryId: id,
        status: 'ready',
        contentHash: memory.contentHash,
        extractionVersion: 2,
      });
      const relationId = `relation-${id}`;
      await store.doc('knowledgeGraphRelations', relationId).set(
        encodeRecord({
          id: relationId,
          agentId: 'owner',
          sourceMemoryId: id,
          subjectEntityId: entityA,
          objectEntityId: entityB,
          predicate: 'knows',
          evidenceQuote: `Fact ${id}`,
          confidence: '1',
          reviewStatus: 'pending',
          validFrom: null,
          validUntil: null,
        }),
      );
      return relationId;
    }

    it('traverses verified graph sources and rechecks rejection, ownership, provenance and erasure', async () => {
      const seed = await graphMemory('seed', 'a', 'b');
      const connected = await graphMemory('neighbor', 'b', 'c');
      await graphMemory('expired', 'd', 'e', { expiresAt: new Date(0) });
      const repo = new FirestoreGraphRecallRepository(store, space);
      expect(
        (await repo.seeds({ agentId: 'owner', embedding: vector, limit: 4, extractionVersion: 2 }))
          .map((row) => row.relationId)
          .sort(),
      ).toEqual([connected, seed].sort());
      const follow = {
        agentId: 'owner',
        entityIds: ['b'],
        sourceMemoryIds: ['seed'],
        limit: 4,
        extractionVersion: 2,
      };
      expect((await repo.connected(follow)).map((row) => row.relationId)).toEqual([connected]);
      await store.doc('knowledgeGraphRelations', connected).update({ reviewStatus: 'rejected' });
      expect(await repo.connected(follow)).toEqual([]);
      await store.doc('knowledgeGraphRelations', connected).update({ reviewStatus: 'pending' });
      await store.doc('knowledgeGraphSources', 'neighbor').update({ contentHash: 'changed' });
      expect(await repo.connected(follow)).toEqual([]);
      await store.doc('knowledgeGraphSources', 'neighbor').update({ contentHash: 'hash-neighbor' });
      await store.doc('knowledgeGraphEntities', 'c').update({ agentId: 'foreign' });
      expect(await repo.connected(follow)).toEqual([]);
      await store.doc('knowledgeGraphEntities', 'c').update({ agentId: 'owner' });
      await new FirestoreMemoryRepository(store, space).forget('hash-neighbor');
      expect(await repo.connected(follow)).toEqual([]);
    });

    it('records scoped content-free recall metrics and purges only the requested age', async () => {
      await store.doc('agents', 'owner').set({ id: 'owner' });
      await conversation('current');
      const repo = new FirestoreRecallMetricsRepository(store);
      const metric = {
        agentId: 'owner',
        conversationId: 'current',
        path: 'executor' as const,
        graphAttempted: true,
        graphFailed: false,
        historyFailed: false,
        graphCandidates: 2,
        graphUsed: 1,
        historyTier: 'message' as const,
        historyUsed: 1,
        sourceCount: 2,
      };
      await repo.record(metric);
      await expect(repo.record({ ...metric, taskId: randomUUID() })).rejects.toThrow(
        'missing source',
      );
      expect(await repo.purge({ notAfter: before, limit: 10 })).toBe(0);
      expect(await repo.purge({ notAfter: now, limit: 10 })).toBe(1);
    });
  },
);
