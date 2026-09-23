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

describe.skipIf(!localEmulator)('Firestore person detail with PostgreSQL offline', () => {
  const installationId = `web-person-${randomUUID()}`;
  const foreignInstallationId = `web-person-foreign-${randomUUID()}`;
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
  let page: typeof import('./page.js');
  const params = (id: string) => ({ params: Promise.resolve({ id }) });

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
      store.doc('contacts', contactId).set({
        id: contactId,
        name: 'Anna Example',
        relationship: 'daughter',
        trust: 'confirmed',
        aliases: ['Annie'],
        emails: ['anna@example.test'],
        phones: ['555-0100'],
        notes: 'Likes hiking',
      }),
      store.doc('contacts', ownerContactId).set({
        id: ownerContactId,
        name: 'Owner private contact',
        relationship: '',
        trust: 'owner',
      }),
      foreignStore.doc('agents', otherAgentId).set({ id: otherAgentId, name: 'Foreign' }),
      foreignStore.doc('contacts', foreignContactId).set({
        id: foreignContactId,
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

  it('allows only UUID detail GET through the Firestore proxy', async () => {
    const { proxy } = await import('../../../proxy.js');
    const request = (path: string, method = 'GET') =>
      new NextRequest(`http://localhost${path}`, { method });
    expect(proxy(request(`/people/${contactId}`)).status).toBe(200);
    expect(proxy(request(`/people/${contactId}`, 'POST')).status).toBe(503);
    expect(proxy(request('/people/not-a-uuid')).status).toBe(503);
  });

  it('shows owner-scoped saved details without SQL or mutation controls', async () => {
    const html = renderToStaticMarkup(await page.default(params(contactId)));
    expect(mocks.owner).toHaveBeenCalled();
    expect(mocks.db).not.toHaveBeenCalled();
    expect(html).toContain('Anna Example');
    expect(html).toContain('daughter');
    expect(html).toContain('Annie');
    expect(html).toContain('anna@example.test');
    expect(html).toContain('Likes hiking');
    expect(html).not.toContain('Add fact');
    expect(html).not.toContain('Delete person');
    expect(html).not.toContain('<form');
  });

  it('links UUID contacts from the read-only directory', async () => {
    const directory = await import('../page.js');
    const html = renderToStaticMarkup(
      await directory.default({ searchParams: Promise.resolve({}) }),
    );
    expect(html).toContain(`href="/people/${contactId}"`);
    expect(html).not.toContain(`href="/people/${foreignContactId}"`);
    expect(html).not.toContain(`href="/people/${ownerContactId}"`);
  });

  it('authenticates before reading and hides absent, foreign, and owner contacts', async () => {
    mocks.owner.mockRejectedValueOnce(new Error('owner authentication required'));
    await expect(page.default(params(contactId))).rejects.toThrow('owner authentication required');
    for (const id of [randomUUID(), foreignContactId, ownerContactId]) {
      await expect(page.default(params(id))).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    }
  });

  it('rejects a configured agent mismatch and ambiguous installation', async () => {
    vi.stubEnv('FIRESTORE_AGENT_ID', otherAgentId);
    resetConfigForTest();
    try {
      await expect(page.default(params(contactId))).rejects.toThrow('exactly one configured agent');
    } finally {
      vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
      resetConfigForTest();
    }
    await store.doc('agents', otherAgentId).set({ id: otherAgentId });
    try {
      await expect(page.default(params(contactId))).rejects.toThrow('exactly one configured agent');
    } finally {
      await store.doc('agents', otherAgentId).delete();
    }
  });

  it('fails closed while privacy erasure is active', async () => {
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    try {
      await expect(page.default(params(contactId))).rejects.toThrow(
        'Privacy erasure is in progress',
      );
    } finally {
      await store.doc('privacyErasureJobs', agentId).delete();
    }
  });
});
