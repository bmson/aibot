import { randomUUID } from 'node:crypto';
import type { Records } from '@assistant/persistence';
import { afterEach, describe, expect, it } from 'vitest';
import { FirestoreMemoryRepository } from './memory.js';
import { FirestorePrivacyErasureRepository } from './privacy-erasure.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe('Firestore privacy erasure', () => {
  const stores: ReturnType<typeof emulatorStore>[] = [];
  afterEach(async () => Promise.all(stores.splice(0).map(disposeStore)));

  it('erases all owner domains, retains tombstones, and resumes after interruption', async () => {
    const store = emulatorStore();
    stores.push(store);
    const agentId = randomUUID();
    const foreignId = randomUUID();
    const memoryId = randomUUID();
    const relationId = randomUUID();
    const entityId = randomUUID();
    const aliasId = randomUUID();
    const packId = randomUUID();
    const previewId = randomUUID();
    const importId = randomUUID();
    const taskId = randomUUID();
    const sampleId = randomUUID();
    const hash = `privacy-${randomUUID()}`;
    const now = new Date('2026-09-22T12:00:00Z');
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId }),
      store.doc('memories', memoryId).set({ id: memoryId, agentId, contentHash: hash }),
      store.doc('memoryContentHashes', hash).set({ memoryId }),
      store.doc('knowledgeGraphSources', memoryId).set({ memoryId, contentHash: hash }),
      store.doc('knowledgeGraphRelations', relationId).set({ id: relationId, agentId }),
      store.doc('knowledgeGraphEntities', entityId).set({ id: entityId, agentId }),
      store.doc('knowledgeGraphEntityAliases', aliasId).set({ id: aliasId, agentId }),
      store.doc('situationPacks', packId).set({
        id: packId,
        agentId,
        data: { title: 'Plan', decisions: [{ reason: 'private' }] },
        version: 3,
      }),
      store.doc('situationPreviews', previewId).set({ id: previewId, packId }),
      store.doc('importSources', importId).set({
        id: importId,
        agentId,
        source: 'voice-samples-mail',
        workspacePath: 'import/voice.txt',
        taskId,
      }),
      store.doc('tasks', taskId).set({ id: taskId, agentId, status: 'running' }),
      store.doc('writingSamples', sampleId).set({ id: sampleId, text: 'private' }),
      store.doc('voiceProfile', '1').set({ id: 1, description: 'private', signature: 'private' }),
      store.doc('ownerCards', agentId).set({ agentId, content: 'private', compiledAt: now }),
      store.doc('knowledgeGraphRelations', foreignId).set({ id: foreignId, agentId: foreignId }),
      store
        .doc('memories', foreignId)
        .set({ id: foreignId, agentId: foreignId, contentHash: 'foreign' }),
    ]);
    const repository = new FirestorePrivacyErasureRepository(store);
    // A malformed sample interrupts the final phase after memory and graph removal.
    await store.doc('writingSamples', sampleId).update({ id: 'forged' });
    await expect(repository.erase()).rejects.toThrow('Writing sample identity mismatch');
    expect((await store.doc('privacyErasureJobs', agentId).get()).get('status')).toBe('active');
    expect((await store.doc('memoryTombstones', hash).get()).get('reason')).toBe('owner_forget');
    expect((await store.doc('memories', memoryId).get()).exists).toBe(false);
    await expect(
      new FirestoreMemoryRepository(store, {
        provider: 'test',
        model: 'unit',
        dimensions: 3,
        revision: '1',
      }).save({
        id: randomUUID(),
        agentId,
        contentHash: `new-${randomUUID()}`,
        embedding: [1, 0, 0],
      } as Records['memories']),
    ).rejects.toThrow('Privacy erasure is in progress');
    await store.doc('writingSamples', sampleId).update({ id: sampleId });
    await expect(repository.erase()).resolves.toEqual({
      memories: 1,
      graphRelations: 1,
      writingSamples: 1,
    });
    expect((await store.doc('privacyErasureJobs', agentId).get()).get('status')).toBe(
      'content-erased',
    );
    expect((await store.doc('knowledgeGraphEntities', entityId).get()).exists).toBe(false);
    expect((await store.doc('knowledgeGraphEntityAliases', aliasId).get()).exists).toBe(false);
    expect((await store.doc('knowledgeGraphSources', memoryId).get()).exists).toBe(false);
    expect((await store.doc('memoryContentHashes', hash).get()).exists).toBe(false);
    expect((await store.doc('situationPreviews', previewId).get()).exists).toBe(false);
    expect((await store.doc('situationPacks', packId).get()).data()).toMatchObject({
      data: { title: 'Plan', decisions: [] },
      version: 4,
    });
    expect((await store.doc('tasks', taskId).get()).get('status')).toBe('cancelled');
    expect((await store.doc('ownerCards', agentId).get()).get('content')).toBe('');
    expect((await store.doc('voiceProfile', '1').get()).get('description')).toBe('');
    expect((await store.doc('memories', foreignId).get()).exists).toBe(true);
    expect((await store.doc('knowledgeGraphRelations', foreignId).get()).exists).toBe(true);
    await expect(repository.pendingAssets()).resolves.toEqual([
      { id: importId, workspacePath: 'import/voice.txt' },
    ]);
    await expect(repository.complete()).rejects.toThrow('assets remain');
    await repository.assetDeleted(importId);
    await repository.complete();
    expect((await store.doc('privacyErasureJobs', agentId).get()).get('status')).toBe('complete');
  });

  it('refuses installation-wide erasure when owner identity is ambiguous', async () => {
    const store = emulatorStore();
    stores.push(store);
    const first = randomUUID();
    const second = randomUUID();
    await Promise.all([
      store.doc('agents', first).set({ id: first }),
      store.doc('agents', second).set({ id: second }),
    ]);
    await expect(new FirestorePrivacyErasureRepository(store).erase()).rejects.toThrow(
      'exactly one configured owner',
    );
    expect((await store.collection('privacyErasureJobs').get()).empty).toBe(true);
  });

  it('drains more than one transaction page without losing tombstones or counts', async () => {
    const store = emulatorStore();
    stores.push(store);
    const agentId = randomUUID();
    await store.doc('agents', agentId).set({ id: agentId });
    const rows = Array.from({ length: 53 }, () => ({ id: randomUUID(), hash: randomUUID() }));
    const batch = store.db.batch();
    for (const row of rows) {
      batch.set(store.doc('memories', row.id), { id: row.id, agentId, contentHash: row.hash });
      batch.set(store.doc('memoryContentHashes', row.hash), { memoryId: row.id });
    }
    await batch.commit();
    const repository = new FirestorePrivacyErasureRepository(store);
    await expect(repository.erase()).resolves.toEqual({
      memories: 53,
      graphRelations: 0,
      writingSamples: 0,
    });
    expect((await store.collection('memories').where('agentId', '==', agentId).get()).empty).toBe(
      true,
    );
    for (const row of rows) {
      expect((await store.doc('memoryTombstones', row.hash).get()).exists).toBe(true);
    }
    await repository.complete();
  });

  it('keeps a malformed durable fence closed', async () => {
    const store = emulatorStore();
    stores.push(store);
    const agentId = randomUUID();
    await store.doc('agents', agentId).set({ id: agentId });
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'unknown' });
    await expect(new FirestorePrivacyErasureRepository(store).erase()).rejects.toThrow(
      'job is malformed',
    );
    await expect(
      new FirestoreMemoryRepository(store, {
        provider: 'test',
        model: 'unit',
        dimensions: 3,
        revision: '1',
      }).save({
        id: randomUUID(),
        agentId,
        contentHash: randomUUID(),
        embedding: [1, 0, 0],
      } as Records['memories']),
    ).rejects.toThrow('Privacy erasure is in progress');
  });
});
