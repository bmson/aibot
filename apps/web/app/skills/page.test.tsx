import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore } from '@assistant/firestore';
import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ owner: vi.fn() }));
vi.mock('@/auth', () => ({ requireOwner: auth.owner }));

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore owner Skills page with PostgreSQL offline', () => {
  const installationId = `web-skills-${randomUUID()}`;
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
      '{"provider":"vertex","model":"fixture","dimensions":768,"revision":"1"}',
    );
    vi.stubEnv('LLM_PROVIDER', 'vertex');
    vi.stubEnv('ASSISTANT_MODULES', 'minimal');
    vi.stubEnv('QUEUE_DRIVER', 'local');
    vi.stubEnv('CANARY_ENABLED', 'false');
    vi.stubEnv('LOCATION_PING_SECRET', '');
    resetConfigForTest();
    auth.owner.mockResolvedValue({ user: { email: 'owner@example.test' } });
    page = await import('./page.js');
    const skill = (id: string, owner: string, name: string) => ({
      id,
      agentId: owner,
      name,
      preconditions: '',
      steps: `${name} steps`,
      gotchas: '',
      ownerAuthored: false,
      deprecated: false,
      useCount: 2,
      successCount: 1,
      failureCount: 0,
      updatedAt: new Date('2026-09-22T12:00:00.000Z'),
    });
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId }),
      store.doc('skills', 'owner-skill').set(skill('owner-skill', agentId, 'Private owner skill')),
      store
        .doc('skills', 'foreign-skill')
        .set(skill('foreign-skill', foreignAgentId, 'Foreign skill')),
    ]);
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  it('allows only GET and renders the owner library without write controls', async () => {
    const { proxy } = await import('../../proxy.js');
    expect(proxy(new NextRequest('http://localhost/skills')).status).toBe(200);
    expect(proxy(new NextRequest('http://localhost/skills', { method: 'POST' })).status).toBe(503);
    const html = renderToStaticMarkup(await page.default());
    expect(auth.owner).toHaveBeenCalled();
    expect(html).toContain('Private owner skill');
    expect(html).not.toContain('Foreign skill');
    expect(html).not.toContain('Add skill');
    expect(html).not.toContain('Confirm delete');
    expect(html).not.toContain('<form');
  });

  it('checks owner authentication before exposing skills', async () => {
    auth.owner.mockRejectedValueOnce(new Error('owner authentication required'));
    await expect(page.default()).rejects.toThrow('owner authentication required');
  });

  it('fails closed during erasure and if the configured agent is missing', async () => {
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    try {
      await expect(page.default()).rejects.toThrow('Privacy erasure is in progress');
    } finally {
      await store.doc('privacyErasureJobs', agentId).delete();
    }
    vi.stubEnv('FIRESTORE_AGENT_ID', foreignAgentId);
    resetConfigForTest();
    try {
      await expect(page.default()).rejects.toThrow('Configured learned-skill agent is missing');
    } finally {
      vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
      resetConfigForTest();
    }
  });
});
