import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore } from '@assistant/firestore';
import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ owner: vi.fn() }));
vi.mock('@/auth', () => ({ requireOwner: auth.owner }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore About page with PostgreSQL offline', () => {
  const installationId = `web-about-${randomUUID()}`;
  const agentId = randomUUID();
  const foreignAgentId = randomUUID();
  const ownerId = randomUUID();
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
      '{"provider":"vertex","model":"fixture","dimensions":1536,"revision":"1"}',
    );
    vi.stubEnv('LLM_PROVIDER', 'vertex');
    vi.stubEnv('ASSISTANT_MODULES', 'minimal');
    vi.stubEnv('QUEUE_DRIVER', 'local');
    vi.stubEnv('CANARY_ENABLED', 'false');
    vi.stubEnv('LOCATION_PING_SECRET', '');
    resetConfigForTest();
    auth.owner.mockResolvedValue({ user: { email: 'owner@example.test' } });
    page = await import('./page.js');

    const now = new Date();
    const fact = (id: string, owner: string, content: string) => ({
      id,
      agentId: owner,
      subjectContactId: ownerId,
      category: 'knowledge',
      kind: 'fact',
      content,
      contentHash: `hash-${id}`,
      confidence: '0.9',
      importance: 5,
      domain: 'identity',
      pinned: true,
      ownerConfirmed: true,
      quarantined: false,
      supersededById: null,
      expiresAt: null,
      originTrust: 'owner',
      sourceTaskId: null,
      lastConsolidatedAt: now,
      validFrom: null,
      validUntil: null,
      createdAt: now,
    });
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId }),
      store
        .doc('contacts', ownerId)
        .set({ id: ownerId, name: 'Owner', trust: 'owner', aliases: [], relationship: '' }),
      store.doc('memories', 'owner-fact').set(fact('owner-fact', agentId, 'Private owner fact')),
      store
        .doc('memories', 'foreign-fact')
        .set(fact('foreign-fact', foreignAgentId, 'Foreign fact')),
      store
        .doc('ownerCards', agentId)
        .set({ agentId, content: 'Private conversation summary', compiledAt: now }),
    ]);
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  it('renders the interactive owner facts view with PostgreSQL unreachable', async () => {
    const { proxy } = await import('../../../proxy.js');
    expect(proxy(new NextRequest('http://localhost/profile/about')).status).toBe(200);
    expect(
      proxy(new NextRequest('http://localhost/profile/about', { method: 'POST' })).status,
    ).toBe(200);
    const html = renderToStaticMarkup(await page.default());
    expect(auth.owner).toHaveBeenCalled();
    expect(html).toContain('Private owner fact');
    expect(html).toContain('Private conversation summary');
    expect(html).not.toContain('Foreign fact');
    expect(html).toContain('Refresh summary');
    // Fact commands are portable now, so the full editor renders.
    expect(html).toContain('Add a fact');
  });

  it('recompiles the configured owner card with PostgreSQL unreachable', async () => {
    const { recompileCard } = await import('../actions.js');
    await recompileCard();
    const card = await store.doc('ownerCards', agentId).get();
    expect(card.get('content')).toContain('Private owner fact');
    expect(card.get('content')).not.toContain('Foreign fact');
  });

  it('requires owner authentication before reading', async () => {
    auth.owner.mockRejectedValueOnce(new Error('owner authentication required'));
    await expect(page.default()).rejects.toThrow('owner authentication required');
  });

  it('fails closed during privacy erasure or when the configured agent is missing', async () => {
    const { recompileCard } = await import('../actions.js');
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    try {
      await expect(page.default()).rejects.toThrow('Privacy erasure is in progress');
      await expect(recompileCard()).rejects.toThrow('Privacy erasure is in progress');
    } finally {
      await store.doc('privacyErasureJobs', agentId).delete();
    }
    vi.stubEnv('FIRESTORE_AGENT_ID', foreignAgentId);
    resetConfigForTest();
    try {
      await expect(page.default()).rejects.toThrow(
        'About page requires one matching configured owner',
      );
      await expect(recompileCard()).rejects.toThrow(
        'Owner card refresh requires exactly one configured agent',
      );
    } finally {
      vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
      resetConfigForTest();
    }
  });
});
