import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore } from '@assistant/firestore';
import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ owner: vi.fn(), db: vi.fn() }));
vi.mock('@/auth', () => ({ requireOwner: mocks.owner }));
vi.mock('@/lib/server', () => ({ getDb: mocks.db }));

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore people directory with PostgreSQL offline', () => {
  const installationId = `web-people-${randomUUID()}`;
  const foreignInstallationId = `web-people-foreign-${randomUUID()}`;
  const agentId = randomUUID();
  const foreignAgentId = randomUUID();
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
  const foreignStore = createInstallationStore({
    projectId: 'demo-assistant-test',
    installationId: foreignInstallationId,
  });
  let page: typeof import('./page.js');

  beforeAll(async () => {
    vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
    vi.stubEnv('DATABASE_URL', 'postgres://offline:offline@127.0.0.1:1/offline_test');
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
    mocks.owner.mockResolvedValue({ user: { email: 'owner@example.test' } });
    mocks.db.mockImplementation(() => {
      throw new Error('PostgreSQL is unreachable');
    });
    page = await import('./page.js');
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId, name: 'Assistant' }),
      store.doc('contacts', 'owner').set({
        id: 'owner',
        name: 'Private owner',
        relationship: '',
        trust: 'owner',
      }),
      store.doc('contacts', 'anna').set({
        id: 'anna',
        name: 'Anna Example',
        relationship: 'daughter',
        trust: 'confirmed',
      }),
      store.doc('contacts', 'max').set({
        id: 'max',
        name: 'Max Example',
        relationship: 'colleague',
        trust: 'unknown',
      }),
      foreignStore.doc('agents', foreignAgentId).set({ id: foreignAgentId, name: 'Foreign' }),
      foreignStore.doc('contacts', 'foreign').set({
        id: 'foreign',
        name: 'Foreign private person',
        relationship: 'friend',
        trust: 'confirmed',
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

  const params = (q?: string) => ({ searchParams: Promise.resolve(q ? { q } : {}) });

  it('allows GET only through the Firestore proxy', async () => {
    const { proxy } = await import('../../proxy.js');
    const request = (path: string, method = 'GET') =>
      new NextRequest(`http://localhost${path}`, { method });
    expect(proxy(request('/people')).status).toBe(200);
    expect(proxy(request('/people', 'POST')).status).toBe(503);
    expect(proxy(request('/people/anna')).status).toBe(503);
  });

  it('shows installation contacts without PostgreSQL or unavailable controls', async () => {
    const html = renderToStaticMarkup(await page.default(params()));
    expect(mocks.owner).toHaveBeenCalled();
    expect(mocks.db).not.toHaveBeenCalled();
    expect(html).toContain('Anna Example');
    expect(html).toContain('Max Example');
    expect(html).toContain('daughter');
    expect(html).toContain('Unverified');
    expect(html).not.toContain('Private owner');
    expect(html).not.toContain('Foreign private person');
    expect(html).not.toContain('Add person');
    expect(html).not.toContain('href="/people/');
  });

  it('searches only the safe contact fields', async () => {
    const html = renderToStaticMarkup(await page.default(params('daughter')));
    expect(html).toContain('Anna Example');
    expect(html).not.toContain('Max Example');
  });

  it('authenticates before reading the directory', async () => {
    mocks.owner.mockRejectedValueOnce(new Error('owner authentication required'));
    await expect(page.default(params())).rejects.toThrow('owner authentication required');
  });

  it('rejects a configured agent mismatch and ambiguous installation', async () => {
    vi.stubEnv('FIRESTORE_AGENT_ID', foreignAgentId);
    resetConfigForTest();
    try {
      await expect(page.default(params())).rejects.toThrow('exactly one configured agent');
    } finally {
      vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
      resetConfigForTest();
    }
    await store.doc('agents', foreignAgentId).set({ id: foreignAgentId });
    try {
      await expect(page.default(params())).rejects.toThrow('exactly one configured agent');
    } finally {
      await store.doc('agents', foreignAgentId).delete();
    }
  });

  it('fails closed while privacy erasure is active', async () => {
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    try {
      await expect(page.default(params())).rejects.toThrow('Privacy erasure is in progress');
    } finally {
      await store.doc('privacyErasureJobs', agentId).delete();
    }
  });
});
