import { randomUUID } from 'node:crypto';
import { createInstallationStore, FirestoreGeneratedCardRepository } from '@assistant/firestore';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ mobile: vi.fn() }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: auth.mobile,
  mobileJson: (body: unknown, init?: ResponseInit) => Response.json(body, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore mobile saved cards with PostgreSQL offline', () => {
  const installationId = `mobile-cards-${randomUUID()}`;
  const agentId = randomUUID();
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
  const cards = new FirestoreGeneratedCardRepository(store);
  const url = 'http://localhost/api/mobile/v1/cards';
  const imageUrl = 'https://example.com/images/card.png';
  const cardSpec = (title: string) => ({
    version: 1,
    title,
    icon: 'generic',
    accent: 'mint',
    accessibilityLabel: title,
    sourceLabel: 'test',
    facts: [{ id: 'image', value: imageUrl, source: 'test' }],
    blocks: [{ type: 'image', urlFact: 'image' }],
    actions: [],
    refreshable: false,
  });

  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://assistant:assistant@127.0.0.1:1/offline_test');
    vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
    vi.stubEnv('ASSISTANT_MODULES', 'minimal');
    vi.stubEnv('ASSISTANT_WORKSPACE_ID', installationId);
    vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
    vi.stubEnv(
      'FIRESTORE_EMBEDDING_SPACE',
      '{"provider":"openai","model":"text-embedding-3-small","dimensions":1536,"revision":"1"}',
    );
    vi.stubEnv('GCP_PROJECT', 'demo-assistant-test');
    vi.stubEnv('QUEUE_DRIVER', 'local');
    vi.stubEnv('CANARY_ENABLED', 'false');
    vi.stubEnv('LOCATION_PING_SECRET', '');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    auth.mobile.mockResolvedValue(true);
    const now = new Date();
    await store.doc('agents', agentId).set({
      id: agentId,
      name: 'Assistant',
      timezone: 'UTC',
      createdAt: now,
      updatedAt: now,
    });
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllEnvs();
  });

  it('allows the owner-scoped card route while leaving other writes closed', async () => {
    const { proxy } = await import('../proxy.js');
    const status = (path: string, method = 'GET') =>
      proxy(new NextRequest(`http://localhost${path}`, { method })).status;
    expect(status('/api/mobile/v1/cards')).toBe(200);
    expect(status('/api/mobile/v1/cards', 'POST')).toBe(503);
    expect(status(`/api/mobile/v1/cards/${randomUUID()}`, 'POST')).toBe(200);
    expect(status('/api/mobile/v1/workspace')).toBe(200);
    expect(status('/api/mobile/v1/workspace', 'POST')).toBe(503);
    expect(status('/api/card-image')).toBe(200);
  });

  it('returns only owner cards with the existing schema, image URL, and timestamp', async () => {
    const { GET } = await import('../app/api/mobile/v1/cards/route.js');
    const { getDb } = await import('./server.js');
    expect(() => getDb()).toThrow('PostgreSQL-backed web surface is unavailable');

    auth.mobile.mockResolvedValueOnce(false);
    expect((await GET(new Request(url))).status).toBe(401);

    const own = await cards.createOrRevise({
      agentId,
      id: randomUUID(),
      revisionId: randomUUID(),
      sourceFingerprint: randomUUID(),
      sourceLabel: 'test',
      spec: cardSpec('Owned card'),
      expiresAt: null,
    });
    await cards.createOrRevise({
      agentId: randomUUID(),
      id: randomUUID(),
      revisionId: randomUUID(),
      sourceFingerprint: randomUUID(),
      sourceLabel: 'test',
      spec: cardSpec('Foreign card'),
      expiresAt: null,
    });

    const response = await GET(new Request(url));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { cards: Array<Record<string, unknown>> };
    expect(body.cards).toHaveLength(1);
    expect(body.cards[0]).toMatchObject({
      id: own.card.id,
      revisionId: own.revision.id,
      spec: {
        title: 'Owned card',
        facts: [{ id: 'image', value: imageUrl, source: 'test', sensitive: false }],
        blocks: [{ type: 'image', urlFact: 'image' }],
      },
      updatedAt: own.card.updatedAt.toISOString(),
    });
  }, 30_000);

  it('dismisses cards and queues refreshes through Firestore while PostgreSQL is offline', async () => {
    const { POST } = await import('../app/api/mobile/v1/cards/[id]/route.js');
    const { getDb } = await import('./server.js');
    expect(() => getDb()).toThrow('PostgreSQL-backed web surface is unavailable');

    const dismissId = randomUUID();
    const dismissed = await cards.createOrRevise({
      agentId,
      id: dismissId,
      revisionId: randomUUID(),
      sourceFingerprint: randomUUID(),
      sourceLabel: 'test',
      spec: cardSpec('Dismiss me'),
      expiresAt: null,
    });
    const post = (id: string, action: string) =>
      POST(
        new Request(`http://localhost/api/mobile/v1/cards/${id}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action }),
        }),
        { params: Promise.resolve({ id }) },
      );

    const dismissResponse = await post(dismissId, 'dismiss');
    expect(dismissResponse.status).toBe(200);
    expect(await dismissResponse.json()).toEqual({ ok: true });
    expect((await store.doc('generatedCards', dismissId).get()).get('status')).toBe('dismissed');
    expect((await post(dismissId, 'dismiss')).status).toBe(200);
    expect(await cards.get(agentId, dismissed.card.id)).toBeNull();

    const refreshId = randomUUID();
    const refreshRevisionId = randomUUID();
    await cards.createOrRevise({
      agentId,
      id: refreshId,
      revisionId: refreshRevisionId,
      sourceFingerprint: randomUUID(),
      sourceLabel: 'test',
      spec: {
        ...cardSpec('Refresh me'),
        _runtime: {
          requestText: 'Where is my shipment?',
          sources: [{ toolName: 'gmail.read_thread', args: { threadId: 'shipment-123' } }],
        },
      },
      expiresAt: null,
    });
    const refreshResponse = await post(refreshId, 'refresh');
    expect(refreshResponse.status).toBe(202);
    const result = (await refreshResponse.json()) as { taskId: string; refreshState: string };
    expect(result).toMatchObject({ refreshState: 'refreshing' });
    expect((await store.doc('tasks', result.taskId).get()).get('agentId')).toBe(agentId);

    const fencedId = randomUUID();
    await cards.createOrRevise({
      agentId,
      id: fencedId,
      revisionId: randomUUID(),
      sourceFingerprint: randomUUID(),
      sourceLabel: 'test',
      spec: cardSpec('Fenced card'),
      expiresAt: null,
    });
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    expect((await post(fencedId, 'dismiss')).status).toBe(404);
    expect((await post(refreshId, 'refresh')).status).toBe(404);
    expect((await store.doc('generatedCards', fencedId).get()).get('status')).toBe('active');
    expect((await store.collection('tasks').where('agentId', '==', agentId).get()).size).toBe(1);
    await store.doc('privacyErasureJobs', agentId).delete();
  }, 30_000);
});
