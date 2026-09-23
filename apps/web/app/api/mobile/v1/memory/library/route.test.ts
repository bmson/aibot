import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore } from '@assistant/firestore';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ mobile: vi.fn() }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: auth.mobile,
  mobileJson: (body: unknown, init?: ResponseInit) =>
    Response.json(body, {
      ...init,
      headers: { 'cache-control': 'no-store' },
    }),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore mobile memory library with PostgreSQL offline', () => {
  const installationId = `mobile-memory-library-${randomUUID()}`;
  const agentId = randomUUID();
  const foreignAgentId = randomUUID();
  const ownerContactId = randomUUID();
  const friendContactId = randomUUID();
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
  const url = 'http://localhost/api/mobile/v1/memory/library';
  const now = new Date('2026-09-22T12:00:00.000Z');
  const memory = (id: string, agent: string, content: string, subjectContactId: string | null) => ({
    id,
    agentId: agent,
    category: 'knowledge',
    content,
    contentHash: `${id}-hash`,
    domain: 'relationships',
    source: 'chat',
    createdAt: now,
    expiresAt: null,
    lastConsolidatedAt: null,
    subjectContactId,
    quarantined: false,
    ownerConfirmed: true,
    pinned: false,
    importance: 3,
    originTrust: 'owner',
    embedding: null,
  });

  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://offline:offline@127.0.0.1:1/offline_test');
    vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
    vi.stubEnv('GCP_PROJECT', 'demo-assistant-test');
    vi.stubEnv('ASSISTANT_WORKSPACE_ID', installationId);
    vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
    vi.stubEnv(
      'FIRESTORE_EMBEDDING_SPACE',
      '{"provider":"vertex","model":"example-embedding","dimensions":768,"revision":"fixture-v1"}',
    );
    vi.stubEnv('LLM_PROVIDER', 'vertex');
    vi.stubEnv('ASSISTANT_MODULES', 'minimal');
    vi.stubEnv('QUEUE_DRIVER', 'local');
    vi.stubEnv('CANARY_ENABLED', 'false');
    vi.stubEnv('LOCATION_PING_SECRET', '');
    resetConfigForTest();
    auth.mobile.mockResolvedValue(true);
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId, name: 'Assistant' }),
      store
        .doc('contacts', ownerContactId)
        .set({ id: ownerContactId, name: 'Owner', trust: 'owner' }),
      store
        .doc('contacts', friendContactId)
        .set({ id: friendContactId, name: 'Friend', trust: 'user' }),
      store
        .doc('memories', 'owner-fact')
        .set(memory('owner-fact', agentId, 'I prefer tea', ownerContactId)),
      store
        .doc('memories', 'friend-fact')
        .set(memory('friend-fact', agentId, 'Friend likes coffee', friendContactId)),
      store
        .doc('memories', 'foreign-fact')
        .set(memory('foreign-fact', foreignAgentId, 'Foreign private fact', null)),
    ]);
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  it('allows only the exact GET route through the Firestore proxy', async () => {
    const { proxy } = await import('../../../../../../proxy.js');
    const status = (path: string, method = 'GET') =>
      proxy(new NextRequest(`http://localhost${path}`, { method })).status;
    expect(status('/api/mobile/v1/memory/library')).toBe(200);
    expect(status('/api/mobile/v1/memory/library', 'POST')).toBe(503);
    expect(status('/api/mobile/v1/memory/library/owner-fact')).toBe(503);
    expect(status('/api/mobile/v1/memory/export')).toBe(200);
  });

  it('keeps the mobile row/filter schema and excludes another agent without SQL', async () => {
    const { GET } = await import('./route.js');
    const { getDb } = await import('@/lib/server');
    expect(() => getDb()).toThrow('PostgreSQL-backed web surface is unavailable');
    const response = await GET(new Request(`${url}?q=tea&filter=verified`));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body).toEqual({
      rows: [
        {
          id: 'owner-fact',
          content: 'I prefer tea',
          domain: 'relationships',
          ownerConfirmed: true,
          pinned: false,
          importance: 3,
          organized: false,
          originTrust: 'owner',
          subjectLabel: 'Owner',
          aboutOwner: true,
          connectionCount: 0,
          projectionStatus: 'mapping',
          createdAt: now.toISOString(),
        },
      ],
      total: 1,
      page: 1,
      totalPages: 1,
      subjects: [
        { id: friendContactId, label: 'Friend', trust: 'user' },
        { id: ownerContactId, label: 'Owner', trust: 'owner' },
      ],
      sources: ['chat'],
    });
    const friend = await GET(new Request(`${url}?subjectId=${friendContactId}`));
    const friendBody = await friend.json();
    expect(friendBody.rows).toHaveLength(1);
    expect(friendBody.rows[0]).toMatchObject({ id: 'friend-fact', aboutOwner: false });
    expect(JSON.stringify(friendBody)).not.toContain('Foreign private fact');
  });

  it('authenticates before reading and fails closed for erasure or owner mismatch', async () => {
    const { GET } = await import('./route.js');
    auth.mobile.mockResolvedValueOnce(false);
    expect((await GET(new Request(url))).status).toBe(401);
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    try {
      await expect(GET(new Request(url))).rejects.toThrow('Privacy erasure is in progress');
    } finally {
      await store.doc('privacyErasureJobs', agentId).delete();
    }
    vi.stubEnv('FIRESTORE_AGENT_ID', foreignAgentId);
    resetConfigForTest();
    try {
      await expect(GET(new Request(url))).rejects.toThrow('one matching configured owner');
    } finally {
      vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
      resetConfigForTest();
    }
    await store.doc('agents', foreignAgentId).set({ id: foreignAgentId, name: 'Other' });
    try {
      await expect(GET(new Request(url))).rejects.toThrow('one matching configured owner');
    } finally {
      await store.doc('agents', foreignAgentId).delete();
    }
  });
});
