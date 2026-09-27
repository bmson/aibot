import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore } from '@assistant/firestore';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ allowed: vi.fn() }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: auth.allowed,
  mobileJson: (value: unknown, init?: ResponseInit) =>
    Response.json(value, { ...init, headers: { 'cache-control': 'no-store' } }),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore mobile AI provider settings', () => {
  const databaseId = `mobile-providers-${randomUUID()}`;
  const installationId = `mobile-providers-${randomUUID()}`;
  const agentId = randomUUID();
  const store = createInstallationStore({
    projectId: 'demo-assistant-test',
    installationId,
    databaseId,
  });
  let route: typeof import('./route.js');
  let choice: typeof import('./choice/route.js');
  let item: typeof import('./[id]/route.js');
  const fetchMock = vi.fn();

  const json = (url: string, method: string, body?: unknown) =>
    new Request(`http://localhost${url}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const params = (id: string) => ({ params: Promise.resolve({ id }) });

  beforeAll(async () => {
    vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
    vi.stubEnv('DATABASE_URL', 'postgres://offline:offline@127.0.0.1:1/offline_test');
    vi.stubEnv('GCP_PROJECT', 'demo-assistant-test');
    vi.stubEnv('ASSISTANT_WORKSPACE_ID', installationId);
    vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
    vi.stubEnv('FIRESTORE_DATABASE_ID', databaseId);
    vi.stubEnv('MCP_ENC_KEY', '22'.repeat(32));
    vi.stubEnv('LLM_PROVIDER', 'openrouter');
    vi.stubEnv('OPENROUTER_API_KEY', 'env-openrouter');
    vi.stubEnv('ASSISTANT_MODULES', 'minimal');
    vi.stubEnv('QUEUE_DRIVER', 'local');
    resetConfigForTest();
    vi.stubGlobal('fetch', fetchMock);
    auth.allowed.mockResolvedValue(true);
    route = await import('./route.js');
    choice = await import('./choice/route.js');
    item = await import('./[id]/route.js');
    const priced = (id: string) => ({
      id,
      label: id,
      capabilities: { tools: true },
      promptCostPerMTok: '1.0000',
      completionCostPerMTok: '2.0000',
      latencyClass: 'medium',
      enabled: true,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId }),
      store.doc('models', 'minimax/minimax-m2.7').set(priced('minimax/minimax-m2.7')),
      ...['plan', 'reason', 'draft', 'classify', 'extract', 'rewrite', 'batch'].map((role) =>
        store.doc('modelRoles', role).set({
          role,
          primaryModel: 'minimax/minimax-m2.7',
          fallbackModel: 'minimax/minimax-m2.7',
          params: {},
          updatedAt: new Date(0),
        }),
      ),
    ]);
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  it('lets only these provider routes through the Firestore proxy', async () => {
    const { proxy } = await import('../../../../../proxy.js');
    const status = (path: string, method: string) =>
      proxy(new NextRequest(`http://localhost${path}`, { method })).status;
    expect(status('/api/mobile/v1/providers', 'GET')).toBe(200);
    expect(status('/api/mobile/v1/providers', 'POST')).toBe(200);
    expect(status('/api/mobile/v1/providers/choice', 'PUT')).toBe(200);
    expect(status('/api/mobile/v1/providers/openai', 'POST')).toBe(200);
    expect(status('/api/mobile/v1/providers/openai', 'DELETE')).toBe(503);
    expect(status('/api/mobile/v1/providers/Bad%20Id', 'POST')).toBe(503);
    auth.allowed.mockResolvedValueOnce(false);
    expect((await route.GET(json('/api/mobile/v1/providers', 'GET'))).status).toBe(401);
  });

  it('connects OpenAI, adds a model, switches roles, and never returns the key', async () => {
    fetchMock.mockResolvedValue(Response.json({ data: [{ id: 'gpt-5.1' }] }));
    const connected = await route.POST(
      json('/api/mobile/v1/providers', 'POST', { kind: 'openai', apiKey: 'sk-mobile-secret' }),
    );
    expect(await connected.json()).toEqual({
      id: 'openai',
      models: [expect.objectContaining({ model: 'gpt-5.1' })],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models',
      expect.objectContaining({ headers: { authorization: 'Bearer sk-mobile-secret' } }),
    );
    const stored = (await store.doc('modelConnections', 'openai').get()).get('apiKeyEncrypted');
    expect(stored).toMatch(/^v2\./);
    expect(stored).not.toContain('sk-mobile-secret');

    const added = await item.POST(
      json('/api/mobile/v1/providers/openai', 'POST', {
        action: 'add_model',
        model: 'gpt-5.1',
        promptCostPerMTok: '1.25',
        completionCostPerMTok: 10,
      }),
      params('openai'),
    );
    expect(await added.json()).toEqual({ id: 'openai:gpt-5.1' });

    const chosen = await choice.PUT(
      json('/api/mobile/v1/providers/choice', 'PUT', {
        mainModel: 'openai:gpt-5.1',
        fastModel: 'minimax/minimax-m2.7',
      }),
    );
    expect(chosen.status).toBe(200);
    expect((await store.doc('modelRoles', 'reason').get()).get('primaryModel')).toBe(
      'openai:gpt-5.1',
    );

    const settings = await (await route.GET(json('/api/mobile/v1/providers', 'GET'))).json();
    expect(settings.mainModel).toBe('openai:gpt-5.1');
    expect(settings.connections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'openai', hasApiKey: true, source: 'saved' }),
        expect.objectContaining({ id: 'openrouter', source: 'environment' }),
      ]),
    );
    expect(JSON.stringify(settings)).not.toMatch(/sk-mobile-secret|v2\./);

    const blocked = await item.POST(
      json('/api/mobile/v1/providers/openai', 'POST', { action: 'disable' }),
      params('openai'),
    );
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error).toContain('still used by');
  });
});
