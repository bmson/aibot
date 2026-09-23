import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore } from '@assistant/firestore';
import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ owner: vi.fn() }));
vi.mock('@/auth', () => ({ isAuthed: auth.owner, requireOwner: auth.owner }));

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore profile export with PostgreSQL offline', () => {
  const installationId = `web-profile-export-${randomUUID()}`;
  const agentId = randomUUID();
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
  let route: typeof import('./route.js');

  beforeAll(async () => {
    vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
    vi.stubEnv('DATABASE_URL', 'postgres://offline:offline@127.0.0.1:1/offline_test');
    vi.stubEnv('GCP_PROJECT', 'demo-assistant-test');
    vi.stubEnv('ASSISTANT_WORKSPACE_ID', installationId);
    vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
    vi.stubEnv('LLM_PROVIDER', 'vertex');
    vi.stubEnv('ASSISTANT_MODULES', 'minimal');
    vi.stubEnv('QUEUE_DRIVER', 'local');
    vi.stubEnv('CANARY_ENABLED', 'false');
    vi.stubEnv('LOCATION_PING_SECRET', '');
    resetConfigForTest();
    auth.owner.mockResolvedValue({ user: { email: 'owner@example.test' } });
    route = await import('./route.js');
    await store.doc('agents', agentId).set({ id: agentId, name: 'Assistant' });
    await store.doc('memories', 'owner-fact').set({
      id: 'owner-fact',
      agentId,
      content: 'Private owner fact',
      contentHash: 'private-hash',
      embedding: [0.1, 0.2],
      category: 'knowledge',
      kind: 'fact',
      importance: 3,
      confidence: '0.90',
      originTrust: 'owner',
      quarantined: false,
      domain: null,
      ownerConfirmed: true,
      pinned: false,
      source: null,
      createdAt: new Date('2026-09-22T00:00:00Z'),
      expiresAt: null,
    });
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  it('allows only GET through the Firestore proxy', async () => {
    const { proxy } = await import('../../../proxy.js');
    const request = (path: string, method = 'GET') =>
      new NextRequest(`http://localhost${path}`, { method });
    expect(proxy(request('/profile/data')).status).toBe(200);
    expect(proxy(request('/profile/data', 'POST')).status).toBe(503);
    expect(proxy(request('/api/profile-export')).status).toBe(200);
    expect(proxy(request('/api/profile-export', 'POST')).status).toBe(503);
  });

  it('requires owner authentication before reading data', async () => {
    auth.owner.mockResolvedValueOnce(null);
    const response = await route.GET();
    expect(response.status).toBe(401);
  });

  it('shows the download without an unavailable erase action', async () => {
    const { default: page } = await import('../../profile/data/page.js');
    const markup = renderToStaticMarkup(await page());
    expect(markup).toContain('Download memory export');
    expect(markup).not.toContain('Forget long-term memory');
  });

  it('downloads owner data without credentials, embeddings, or PostgreSQL', async () => {
    const response = await route.GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('attachment;');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.text();
    const payload = JSON.parse(body) as { format: string; memories: { content: string }[] };
    expect(payload.format).toBe('assistant-long-term-memory-export/v1');
    expect(payload.memories.map((memory) => memory.content)).toEqual(['Private owner fact']);
    expect(body).not.toContain('private-hash');
    expect(body).not.toContain('embedding');
  });

  it('rejects a configured agent mismatch', async () => {
    vi.stubEnv('FIRESTORE_AGENT_ID', randomUUID());
    resetConfigForTest();
    try {
      await expect(route.GET()).rejects.toThrow('exactly one configured agent');
    } finally {
      vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
      resetConfigForTest();
    }
  });
});
