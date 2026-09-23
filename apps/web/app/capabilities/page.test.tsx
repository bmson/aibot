import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore } from '@assistant/firestore';
import { assistantModuleMetas } from '@assistant/modules/meta';
import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ owner: vi.fn(), readiness: vi.fn() }));
vi.mock('@/auth', () => ({ requireOwner: mocks.owner }));
vi.mock('@/lib/agent-readiness-source', () => ({
  getAgentReadinessSource: () => ({ read: mocks.readiness }),
}));

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore capabilities page with PostgreSQL offline', () => {
  const installationId = `web-capabilities-${randomUUID()}`;
  const agentId = randomUUID();
  const foreignAgentId = randomUUID();
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
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
    page = await import('./page.js');
    await store.doc('agents', agentId).set({ id: agentId, name: 'Assistant' });
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  it('allows only the GET page through the Firestore proxy', async () => {
    const { proxy } = await import('../../proxy.js');
    const request = (path: string, method = 'GET') =>
      new NextRequest(`http://localhost${path}`, { method });
    expect(proxy(request('/capabilities')).status).toBe(200);
    expect(proxy(request('/capabilities', 'POST')).status).toBe(503);
    expect(proxy(request('/api/mobile/v1/workspace', 'POST')).status).toBe(503);
  });

  it('renders live agent readiness without reaching PostgreSQL', async () => {
    mocks.readiness.mockResolvedValue({
      ready: true,
      database: 'firestore',
      modules: assistantModuleMetas.map((meta) => ({
        module: meta.name,
        enabled: true,
        ready: true,
        detail: 'ready',
      })),
    });
    const html = renderToStaticMarkup(await page.default());
    expect(mocks.owner).toHaveBeenCalled();
    expect(mocks.readiness).toHaveBeenCalledWith(agentId);
    expect(html).toContain('Capabilities');
    expect(html).toContain('Ready');
    expect(html).not.toContain('Status unavailable');
  });

  it('fails closed when agent readiness is unavailable', async () => {
    mocks.readiness.mockRejectedValue(new Error('agent offline'));
    const html = renderToStaticMarkup(await page.default());
    expect(html).toContain('Status unavailable');
    expect(html).not.toContain('Setup needed');
    expect(html).not.toContain('>Ready<');

    mocks.readiness.mockResolvedValue({ ready: true, database: 'firestore', modules: [] });
    const malformedHtml = renderToStaticMarkup(await page.default());
    expect(malformedHtml).toContain('Status unavailable');
    expect(malformedHtml).not.toContain('>Ready<');
  });

  it('requires authentication before reading readiness', async () => {
    mocks.readiness.mockClear();
    mocks.owner.mockRejectedValueOnce(new Error('owner authentication required'));
    await expect(page.default()).rejects.toThrow('owner authentication required');
    expect(mocks.readiness).not.toHaveBeenCalled();
  });

  it('rejects a configured owner missing from the installation', async () => {
    mocks.readiness.mockClear();
    vi.stubEnv('FIRESTORE_AGENT_ID', foreignAgentId);
    resetConfigForTest();
    try {
      await expect(page.default()).rejects.toThrow('outside the configured installation');
      expect(mocks.readiness).not.toHaveBeenCalled();
    } finally {
      vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
      resetConfigForTest();
    }
  });
});
