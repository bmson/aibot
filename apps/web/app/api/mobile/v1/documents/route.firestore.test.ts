import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore, FirestoreDocumentReadRepository } from '@assistant/firestore';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ mobile: vi.fn(), store: null as unknown }));
vi.mock('@/lib/server', () => ({
  getFirestoreInstallationStore: () => auth.store,
  getDb: () => {
    throw new Error('PostgreSQL-backed web surface is unavailable');
  },
  getApplication: () => {
    throw new Error('PostgreSQL-backed web surface is unavailable');
  },
}));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: auth.mobile,
  mobileJson: (body: unknown, init?: ResponseInit) =>
    Response.json(body, { ...init, headers: { 'cache-control': 'no-store' } }),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));

const emulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '');

describe.skipIf(!emulator)('Firestore mobile Documents reads with PostgreSQL offline', () => {
  const installationId = `mobile-documents-${randomUUID()}`;
  const agentId = randomUUID();
  const otherAgentId = randomUUID();
  const documentId = randomUUID();
  const foreignDocumentId = randomUUID();
  const primaryConversationId = randomUUID();
  const fileId = randomUUID();
  const otherFileId = randomUUID();
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
  const now = new Date('2026-09-20T10:00:00.000Z');
  const url = 'http://localhost/api/mobile/v1/documents';

  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://offline:offline@127.0.0.1:1/offline_test');
    vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
    vi.stubEnv('GCP_PROJECT', 'demo-assistant-test');
    vi.stubEnv('ASSISTANT_WORKSPACE_ID', installationId);
    vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
    vi.stubEnv(
      'FIRESTORE_EMBEDDING_SPACE',
      '{"provider":"vertex","model":"test","dimensions":768,"revision":"v1"}',
    );
    vi.stubEnv('LLM_PROVIDER', 'vertex');
    vi.stubEnv('ASSISTANT_MODULES', 'documents');
    vi.stubEnv('QUEUE_DRIVER', 'local');
    vi.stubEnv('CANARY_ENABLED', 'false');
    vi.stubEnv('LOCATION_PING_SECRET', '');
    resetConfigForTest();
    auth.mobile.mockResolvedValue(true);
    auth.store = store;
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId }),
      store.doc('conversations', primaryConversationId).set({
        id: primaryConversationId,
        agentId,
        channel: 'chat',
        title: '',
        trust: 'owner',
        modelOverride: null,
        isPrimary: true,
        metadata: {},
        archivedAt: null,
        lastReadAt: null,
        createdAt: now,
        updatedAt: now,
      }),
      store.doc('files', fileId).set({ id: fileId, agentId, bytes: 456 }),
      store.doc('files', otherFileId).set({ id: otherFileId, agentId: otherAgentId, bytes: 99 }),
      store.doc('documents', documentId).set({
        id: documentId,
        agentId,
        fileId,
        title: 'Owner handbook',
        mime: 'application/pdf',
        source: 'upload',
        trust: 'owner',
        status: 'ready',
        extractor: 'pdf',
        chunkCount: 2,
        charCount: 27,
        error: null,
        createdAt: now,
      }),
      store.doc('documents', foreignDocumentId).set({
        id: foreignDocumentId,
        agentId: otherAgentId,
        fileId: otherFileId,
        title: 'Private foreign doc',
        mime: 'text/plain',
        source: 'upload',
        trust: 'owner',
        status: 'pending',
        extractor: '',
        chunkCount: 1,
        charCount: 9,
        createdAt: new Date(now.getTime() + 1000),
      }),
      store.doc('documentChunks', 'owner-a').set({
        id: 'owner-a',
        agentId,
        documentId,
        chunkIndex: 0,
        text: 'First passage',
        charCount: 13,
      }),
      store.doc('documentChunks', 'owner-b').set({
        id: 'owner-b',
        agentId,
        documentId,
        chunkIndex: 1,
        text: 'Second passage',
        charCount: 14,
      }),
      store.doc('documentChunks', 'foreign').set({
        id: 'foreign',
        agentId: otherAgentId,
        documentId,
        chunkIndex: 2,
        text: 'Foreign passage',
        charCount: 15,
      }),
    ]);
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  it('returns the list DTO, owner-scoped stats, and detail passages without PostgreSQL', async () => {
    const { GET } = await import('./route.js');
    const { GET: getDetail } = await import('./[id]/route.js');
    const { getDb } = await import('@/lib/server');
    expect(() => getDb()).toThrow('PostgreSQL-backed web surface is unavailable');

    const listResponse = await GET(new Request(url));
    expect(listResponse.status).toBe(200);
    expect(listResponse.headers.get('cache-control')).toBe('no-store');
    const list = await listResponse.json();
    expect(list.documents).toEqual([
      {
        id: documentId,
        title: 'Owner handbook',
        mime: 'application/pdf',
        source: 'upload',
        trust: 'owner',
        status: 'ready',
        extractor: 'pdf',
        chunkCount: 2,
        charCount: 27,
        bytes: 456,
        error: null,
        createdAt: now.toISOString(),
      },
    ]);
    expect(list.stats).toEqual({ total: 1, ready: 1, pending: 0, chunks: 2 });
    expect(list.primaryConversationId).toBe(primaryConversationId);
    expect(JSON.stringify(list)).not.toContain('Private foreign doc');

    const detailResponse = await getDetail(new Request(`${url}/${documentId}`), {
      params: Promise.resolve({ id: documentId }),
    });
    expect(detailResponse.status).toBe(200);
    expect(await detailResponse.json()).toEqual({
      document: list.documents[0],
      chunks: [
        { chunkIndex: 0, text: 'First passage', charCount: 13 },
        { chunkIndex: 1, text: 'Second passage', charCount: 14 },
      ],
    });
    const foreignResponse = await getDetail(new Request(`${url}/${foreignDocumentId}`), {
      params: Promise.resolve({ id: foreignDocumentId }),
    });
    expect(foreignResponse.status).toBe(404);
  });

  it('authenticates first and fails closed for Firestore document writes', async () => {
    const { GET, POST } = await import('./route.js');
    const { DELETE } = await import('./[id]/route.js');
    auth.mobile.mockResolvedValueOnce(false);
    expect((await GET(new Request(url))).status).toBe(401);
    expect((await POST(new Request(url, { method: 'POST' }))).status).toBe(501);
    expect(
      (
        await DELETE(new Request(`${url}/${documentId}`, { method: 'DELETE' }), {
          params: Promise.resolve({ id: documentId }),
        })
      ).status,
    ).toBe(501);
  });

  it('supplies the overview Documents panel from Firestore', async () => {
    const { GET } = await import('../overview/route.js');
    const response = await GET(new Request('http://localhost/api/mobile/v1/overview'));
    expect(response.status).toBe(200);
    const overview = await response.json();
    expect(overview.documents.documents.map((document: { id: string }) => document.id)).toEqual([
      documentId,
    ]);
    expect(overview.documents.stats).toEqual({ total: 1, ready: 1, pending: 0, chunks: 2 });
    expect(overview.activity).toEqual({ items: [], archivedCount: 0 });
    expect(overview.goals).toEqual({ items: [], archivedCount: 0 });
    expect(overview.approvals).toEqual({ pending: [], resolved: [] });
  });

  it('keeps the Documents module gate when Firestore is selected', async () => {
    vi.stubEnv('ASSISTANT_MODULES', 'reminders');
    resetConfigForTest();
    try {
      const { GET } = await import('./route.js');
      const { GET: overviewGet } = await import('../overview/route.js');
      expect((await GET(new Request(url))).status).toBe(404);
      const response = await overviewGet(new Request('http://localhost/api/mobile/v1/overview'));
      expect(response.status).toBe(200);
      expect((await response.json()).documents).toEqual({
        documents: [],
        stats: { total: 0, ready: 0, pending: 0, chunks: 0 },
        primaryConversationId: null,
      });
    } finally {
      vi.stubEnv('ASSISTANT_MODULES', 'documents');
      resetConfigForTest();
    }
  });

  it('rejects other unsupported modules instead of bypassing persistence validation', async () => {
    vi.stubEnv('ASSISTANT_MODULES', 'documents,google');
    resetConfigForTest();
    try {
      const { GET } = await import('./route.js');
      const response = await GET(new Request(url));
      expect(response.status).toBe(503);
      expect((await response.json()).error).toContain('only ASSISTANT_MODULES=reminders,calendar');
    } finally {
      vi.stubEnv('ASSISTANT_MODULES', 'documents');
      resetConfigForTest();
    }
  });

  it('fails explicitly when the owner document scan exceeds its bound', async () => {
    const ids: string[] = [];
    for (let offset = 0; offset < 5_000; offset += 500) {
      const batch = store.db.batch();
      for (let index = offset; index < Math.min(offset + 500, 5_000); index++) {
        const id = randomUUID();
        ids.push(id);
        batch.set(store.doc('documents', id), {
          id,
          agentId,
          fileId: randomUUID(),
          title: 'Bound fixture',
          mime: 'text/plain',
          source: 'upload',
          trust: 'owner',
          status: 'ready',
          extractor: 'text',
          chunkCount: 0,
          charCount: 0,
          error: null,
          createdAt: now,
        });
      }
      await batch.commit();
    }
    try {
      await expect(
        new FirestoreDocumentReadRepository(store, agentId).list(agentId),
      ).rejects.toThrow('bounded owner scan limit');
    } finally {
      for (let offset = 0; offset < ids.length; offset += 500) {
        const batch = store.db.batch();
        for (const id of ids.slice(offset, offset + 500)) batch.delete(store.doc('documents', id));
        await batch.commit();
      }
    }
  });

  it('fails explicitly when a document detail exceeds its chunk bound', async () => {
    const chunkIds: string[] = [];
    for (let offset = 0; offset < 1_001; offset += 500) {
      const batch = store.db.batch();
      for (let index = offset; index < Math.min(offset + 500, 1_001); index++) {
        const id = `overflow-${index}`;
        chunkIds.push(id);
        batch.set(store.doc('documentChunks', id), {
          id,
          agentId,
          documentId,
          chunkIndex: index,
          text: 'overflow fixture',
          charCount: 16,
        });
      }
      await batch.commit();
    }
    try {
      await expect(
        new FirestoreDocumentReadRepository(store, agentId).get(agentId, documentId),
      ).rejects.toThrow('bounded chunk limit');
    } finally {
      for (let offset = 0; offset < chunkIds.length; offset += 500) {
        const batch = store.db.batch();
        for (const id of chunkIds.slice(offset, offset + 500))
          batch.delete(store.doc('documentChunks', id));
        await batch.commit();
      }
    }
  });
});
