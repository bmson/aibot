import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore } from '@assistant/firestore';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ mobile: vi.fn(), web: vi.fn(), store: vi.fn() }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: auth.mobile,
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/auth', () => ({ isAuthed: auth.web }));
vi.mock('@/lib/server', () => ({
  getApplication: () => {
    throw new Error('PostgreSQL is unreachable');
  },
  getFirestoreInstallationStore: auth.store,
}));

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore mobile memory export with PostgreSQL offline', () => {
  const installationId = `mobile-memory-export-${randomUUID()}`;
  const agentId = randomUUID();
  const foreignAgentId = randomUUID();
  const memoryId = randomUUID();
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
  let mobileRoute: typeof import('./route.js');
  let webRoute: typeof import('../../../../profile-export/route.js');

  beforeAll(async () => {
    vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
    vi.stubEnv('DATABASE_URL', 'postgres://offline:offline@127.0.0.1:1/offline_test');
    vi.stubEnv('GCP_PROJECT', 'demo-assistant-test');
    vi.stubEnv('ASSISTANT_WORKSPACE_ID', installationId);
    vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
    vi.stubEnv(
      'FIRESTORE_EMBEDDING_SPACE',
      '{"provider":"vertex","model":"fixture","dimensions":768,"revision":"1"}',
    );
    vi.stubEnv('LLM_PROVIDER', 'vertex');
    vi.stubEnv('ASSISTANT_MODULES', 'minimal');
    vi.stubEnv('QUEUE_DRIVER', 'local');
    vi.stubEnv('CANARY_ENABLED', 'false');
    vi.stubEnv('LOCATION_PING_SECRET', '');
    resetConfigForTest();
    auth.mobile.mockResolvedValue(true);
    auth.web.mockResolvedValue(true);
    auth.store.mockReturnValue(store);
    mobileRoute = await import('./route.js');
    webRoute = await import('../../../../profile-export/route.js');
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId, name: 'Owner' }),
      store.doc('memories', memoryId).set({
        id: memoryId,
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: 'The owner prefers local exports.',
        contentHash: 'private-owner-hash',
        embedding: [0.1, 0.2],
        importance: 3,
        confidence: '0.90',
        originTrust: 'owner',
        quarantined: false,
        domain: null,
        ownerConfirmed: true,
        pinned: false,
        source: null,
        createdAt: new Date('2026-09-22T12:00:00Z'),
        expiresAt: null,
      }),
    ]);
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  const get = () => mobileRoute.GET(new Request('http://localhost/api/mobile/v1/memory/export'));

  it('exposes GET only and downloads the same scoped data as web', async () => {
    const { proxy } = await import('../../../../../../proxy.js');
    expect(proxy(new NextRequest('http://localhost/api/mobile/v1/memory/export')).status).toBe(200);
    expect(
      proxy(new NextRequest('http://localhost/api/mobile/v1/memory/export', { method: 'POST' }))
        .status,
    ).toBe(503);
    const mobile = await get();
    const web = await webRoute.GET();
    expect(mobile.status).toBe(200);
    expect(mobile.headers.get('cache-control')).toBe('no-store');
    expect(mobile.headers.get('content-disposition')).toContain('attachment;');
    const mobileData = await mobile.json();
    const webData = await web.json();
    expect(mobileData).toEqual({ ...webData, exportedAt: mobileData.exportedAt });
    expect(mobileData.memories.map((row: { id: string }) => row.id)).toEqual([memoryId]);
    expect(JSON.stringify(mobileData)).not.toContain('private-owner-hash');
    expect(JSON.stringify(mobileData)).not.toContain('embedding');
  });

  it('authenticates before reading private data', async () => {
    auth.mobile.mockResolvedValueOnce(false);
    expect((await get()).status).toBe(401);
  });

  it('rejects another configured agent and active privacy erasure', async () => {
    vi.stubEnv('FIRESTORE_AGENT_ID', foreignAgentId);
    resetConfigForTest();
    try {
      await expect(get()).rejects.toThrow('exactly one configured agent');
    } finally {
      vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
      resetConfigForTest();
    }
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    try {
      await expect(get()).rejects.toThrow('Privacy erasure is in progress');
    } finally {
      await store.doc('privacyErasureJobs', agentId).delete();
    }
  });
});
