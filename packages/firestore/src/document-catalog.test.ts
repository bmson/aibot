import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FirestoreDocumentCatalogRepository } from './document-catalog.js';
import { createInstallationStore } from './store.js';

const emulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '');

describe.skipIf(!emulator)('Firestore document catalog records', () => {
  const installationId = `document-catalog-${randomUUID()}`;
  const agentId = randomUUID();
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
  const repository = new FirestoreDocumentCatalogRepository(store, agentId);
  const now = new Date('2026-09-22T12:00:00.000Z');
  const sha256 = 'a'.repeat(64);

  function input(options: { sha256?: string; agentId?: string } = {}) {
    const id = randomUUID();
    const fileId = randomUUID();
    const owner = options.agentId ?? agentId;
    const hash = options.sha256 ?? sha256;
    return {
      file: {
        id: fileId,
        createdAt: now,
        agentId: owner,
        taskId: null,
        workspacePath: `documents/uploads/${fileId}.txt`,
        mime: 'text/plain',
        bytes: 12,
        sha256: hash,
      },
      document: {
        id,
        createdAt: now,
        updatedAt: now,
        agentId: owner,
        title: 'Owner notes',
        status: 'pending',
        trust: 'owner',
        error: null,
        source: 'upload',
        sourceRef: '',
        mime: 'text/plain',
        sha256: hash,
        fileId,
        extractor: 'text',
        chunkCount: 0,
        charCount: 0,
        processorTokenHash: null,
        processorStartedAt: null,
        processorAttempts: 0,
        processedTextPath: null,
      },
    };
  }

  beforeAll(async () => {
    await store.doc('agents', agentId).set({ id: agentId });
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
  });

  it('creates file and document records atomically and deduplicates by owner hash', async () => {
    const first = input();
    const created = await repository.createDocumentCatalog(first);
    expect(created).toEqual({ document: first.document, duplicate: false });
    expect((await store.doc('files', first.file.id).get()).data()).toMatchObject(first.file);
    expect((await store.doc('documents', first.document.id).get()).data()).toMatchObject(
      first.document,
    );

    const duplicate = input();
    const result = await repository.createDocumentCatalog(duplicate);
    expect(result).toEqual({ document: first.document, duplicate: true });
    expect((await store.doc('files', duplicate.file.id).get()).exists).toBe(false);
    expect((await store.doc('documents', duplicate.document.id).get()).exists).toBe(false);
  });

  it('serializes concurrent writes for the same owner hash', async () => {
    const candidates = [input({ sha256: 'b'.repeat(64) }), input({ sha256: 'b'.repeat(64) })];
    const results = await Promise.all(
      candidates.map((candidate) => repository.createDocumentCatalog(candidate)),
    );
    expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
    expect(results.filter((result) => result.duplicate)).toHaveLength(1);
    expect(results[0]?.document.id).toBe(results[1]?.document.id);
  });

  it('fails closed for a foreign owner and while privacy erasure is active', async () => {
    await expect(
      repository.createDocumentCatalog(input({ agentId: randomUUID() })),
    ).rejects.toThrow('outside the configured owner');
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    try {
      await expect(
        repository.createDocumentCatalog(input({ sha256: 'c'.repeat(64) })),
      ).rejects.toThrow('Privacy erasure is in progress');
    } finally {
      await store.doc('privacyErasureJobs', agentId).delete();
    }
  });

  it('adopts matching legacy documents without creating another file record', async () => {
    const legacy = input({ sha256: 'd'.repeat(64) });
    await store.doc('files', legacy.file.id).set(legacy.file);
    await store.doc('documents', legacy.document.id).set(legacy.document);
    const duplicate = input({ sha256: 'd'.repeat(64) });
    const result = await repository.createDocumentCatalog(duplicate);
    expect(result).toEqual({ document: legacy.document, duplicate: true });
    expect((await store.doc('files', duplicate.file.id).get()).exists).toBe(false);
    const claim = await store.collection('documentDedupKeys').where('agentId', '==', agentId).get();
    expect(claim.docs.filter((snapshot) => snapshot.get('sha256') === 'd'.repeat(64)).length).toBe(
      1,
    );
  });
});
