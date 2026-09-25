import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore } from '@assistant/firestore';
import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ owner: vi.fn() }));
vi.mock('@/auth', () => ({ requireOwner: auth.owner }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), unstable_cache: (run: unknown) => run }));

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore memory hub page with PostgreSQL offline', () => {
  const installationId = `web-profile-hub-${randomUUID()}`;
  const agentId = randomUUID();
  const ownerId = randomUUID();
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
  let page: typeof import('./page.js');

  beforeAll(async () => {
    vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
    vi.stubEnv('DATABASE_URL', 'postgres://offline:offline@127.0.0.1:1/offline_test');
    vi.stubEnv('GCP_PROJECT', 'demo-assistant-test');
    vi.stubEnv('ASSISTANT_WORKSPACE_ID', installationId);
    vi.stubEnv('FIRESTORE_DATABASE_ID', '(default)');
    vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
    vi.stubEnv(
      'FIRESTORE_EMBEDDING_SPACE',
      '{"provider":"vertex","model":"fixture","dimensions":1536,"revision":"1"}',
    );
    vi.stubEnv('LLM_PROVIDER', 'vertex');
    vi.stubEnv('ASSISTANT_MODULES', 'minimal');
    vi.stubEnv('QUEUE_DRIVER', 'local');
    vi.stubEnv('CANARY_ENABLED', 'false');
    resetConfigForTest();
    auth.owner.mockResolvedValue({ user: { email: 'owner@example.test' } });
    page = await import('./page.js');
    const now = new Date();
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId, name: 'Assistant' }),
      store.doc('contacts', ownerId).set({
        id: ownerId,
        name: 'Ada Owner',
        trust: 'owner',
        aliases: [],
        relationship: '',
      }),
      store.doc('memories', 'review-me').set({
        id: 'review-me',
        agentId,
        subjectContactId: ownerId,
        category: 'knowledge',
        kind: 'fact',
        content: 'Quarantined claim awaiting review',
        contentHash: 'hash-review',
        confidence: '0.5',
        importance: 3,
        domain: 'other',
        pinned: false,
        ownerConfirmed: false,
        quarantined: true,
        supersededById: null,
        expiresAt: null,
        originTrust: 'unknown',
        sourceTaskId: null,
        lastConsolidatedAt: null,
        validFrom: null,
        validUntil: null,
        createdAt: now,
      }),
      store.doc('commitments', 'loop').set({
        id: 'loop',
        agentId,
        kind: 'promise',
        title: 'Send Grace the slides',
        details: '',
        nextAction: '',
        status: 'open',
        dueAt: null,
        snoozedUntil: null,
        createdAt: now,
        updatedAt: now,
      }),
    ]);
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  it('renders review items and open loops from Firestore', async () => {
    const { proxy } = await import('@/proxy');
    for (const method of ['GET', 'POST'])
      expect(proxy(new NextRequest('http://localhost/profile', { method })).status).toBe(200);
    const { getDb } = await import('@/lib/server');
    expect(() => getDb()).toThrow('PostgreSQL-backed web surface is unavailable');

    const html = renderToStaticMarkup(await page.default());
    expect(html).toContain('Quarantined claim awaiting review');
    expect(html).toContain('Send Grace the slides');
  });

  it('requires the owner before reading', async () => {
    auth.owner.mockRejectedValueOnce(new Error('owner authentication required'));
    await expect(page.default()).rejects.toThrow('owner authentication required');
  });
});
