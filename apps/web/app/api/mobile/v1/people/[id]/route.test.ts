import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore } from '@assistant/firestore';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), db: vi.fn() }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: mocks.auth,
  mobileJson: (value: unknown, init?: ResponseInit) => Response.json(value, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/server', () => ({ getDb: mocks.db }));

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore mobile person detail with PostgreSQL offline', () => {
  const installationId = `mobile-person-${randomUUID()}`;
  const foreignInstallationId = `mobile-person-foreign-${randomUUID()}`;
  const agentId = randomUUID();
  const otherAgentId = randomUUID();
  const contactId = randomUUID();
  const foreignContactId = randomUUID();
  const ownerContactId = randomUUID();
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
  const foreignStore = createInstallationStore({
    projectId: 'demo-assistant-test',
    installationId: foreignInstallationId,
  });
  let route: typeof import('./route.js');
  const request = (id: string) => new Request(`https://example.test/api/mobile/v1/people/${id}`);
  const context = (id: string) => ({ params: Promise.resolve({ id }) });

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
    mocks.auth.mockResolvedValue(true);
    mocks.db.mockImplementation(() => {
      throw new Error('PostgreSQL is unreachable');
    });
    route = await import('./route.js');
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId }),
      store.doc('contacts', contactId).set({
        id: contactId,
        name: 'Anna Example',
        relationship: 'daughter',
        trust: 'confirmed',
      }),
      store.doc('contacts', ownerContactId).set({
        id: ownerContactId,
        name: 'Owner private contact',
        relationship: '',
        trust: 'owner',
      }),
      foreignStore.doc('agents', otherAgentId).set({ id: otherAgentId }),
      foreignStore.doc('contacts', foreignContactId).set({
        id: foreignContactId,
        name: 'Foreign private person',
        relationship: 'friend',
        trust: 'confirmed',
      }),
      store.doc('memories', 'active-fact').set({
        id: 'active-fact',
        agentId,
        subjectContactId: contactId,
        category: 'knowledge',
        quarantined: false,
        expiresAt: null,
        createdAt: new Date(),
        pinned: false,
        importance: 0.5,
        confidence: 0.9,
      }),
    ]);
  });

  afterAll(async () => {
    await Promise.all([
      store.db.recursiveDelete(store.root),
      foreignStore.db.recursiveDelete(foreignStore.root),
    ]);
    await Promise.all([store.db.terminate(), foreignStore.db.terminate()]);
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  it('allows only exact UUID GET through the Firestore proxy', async () => {
    const { proxy } = await import('../../../../../../proxy.js');
    const nextRequest = (path: string, method = 'GET') =>
      new NextRequest(`https://example.test${path}`, { method });
    expect(proxy(nextRequest(`/api/mobile/v1/people/${contactId}`)).status).toBe(200);
    expect(proxy(nextRequest(`/api/mobile/v1/people/${contactId}`, 'PATCH')).status).toBe(503);
    expect(proxy(nextRequest('/api/mobile/v1/people/not-a-uuid')).status).toBe(503);
    expect(proxy(nextRequest('/api/mobile/v1/people')).status).toBe(503);
  });

  it('returns the mobile card shape with real contact and fact fields', async () => {
    const response = await route.GET(request(contactId), context(contactId));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: contactId,
      name: 'Anna Example',
      initials: 'AE',
      relationship: 'daughter',
      group: 'family',
      groupLabel: 'Family',
      trust: 'confirmed',
      location: null,
      birthday: null,
      lastContact: null,
      howWeMet: [],
      relations: [],
      connections: [],
      events: [],
      eventsAreRecent: false,
      reminder: null,
      factCount: 1,
    });
    expect(mocks.db).not.toHaveBeenCalled();
  });

  it('authenticates before reads and hides missing, foreign, and owner contacts', async () => {
    mocks.auth.mockResolvedValueOnce(false);
    expect((await route.GET(request(contactId), context(contactId))).status).toBe(401);
    expect((await route.GET(request('bad'), context('bad'))).status).toBe(400);
    for (const id of [randomUUID(), foreignContactId, ownerContactId]) {
      const response = await route.GET(request(id), context(id));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'person not found' });
    }
  });

  it('rejects configured-agent mismatch and ambiguous installations', async () => {
    vi.stubEnv('FIRESTORE_AGENT_ID', otherAgentId);
    resetConfigForTest();
    try {
      await expect(route.GET(request(contactId), context(contactId))).rejects.toThrow(
        'exactly one configured agent',
      );
    } finally {
      vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
      resetConfigForTest();
    }
    await store.doc('agents', otherAgentId).set({ id: otherAgentId });
    try {
      await expect(route.GET(request(contactId), context(contactId))).rejects.toThrow(
        'exactly one configured agent',
      );
    } finally {
      await store.doc('agents', otherAgentId).delete();
    }
  });

  it('fails closed while privacy erasure is active', async () => {
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    try {
      await expect(route.GET(request(contactId), context(contactId))).rejects.toThrow(
        'Privacy erasure is in progress',
      );
    } finally {
      await store.doc('privacyErasureJobs', agentId).delete();
    }
  });
});
