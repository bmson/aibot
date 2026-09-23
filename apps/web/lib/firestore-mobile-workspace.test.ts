import { randomUUID } from 'node:crypto';
import { createInstallationStore } from '@assistant/firestore';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ isMobileAuthed: vi.fn() }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: auth.isMobileAuthed,
  mobileJson: (body: unknown) => Response.json(body),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/agent-readiness-source', () => ({
  getAgentReadinessSource: () => ({ read: async () => null }),
}));

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore mobile workspace with PostgreSQL offline', () => {
  const installationId = `mobile-workspace-${randomUUID()}`;
  const agentId = randomUUID();
  const ownerContactId = randomUUID();
  const foreignAgentId = randomUUID();
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
  const now = new Date();

  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://unreachable@127.0.0.1:1/offline');
    vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
    vi.stubEnv('ASSISTANT_MODULES', 'minimal');
    vi.stubEnv('ASSISTANT_WORKSPACE_ID', installationId);
    vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
    vi.stubEnv(
      'FIRESTORE_EMBEDDING_SPACE',
      JSON.stringify({
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 1536,
        revision: '1',
      }),
    );
    vi.stubEnv('GCP_PROJECT', 'demo-assistant-test');
    vi.stubEnv('QUEUE_DRIVER', 'local');
    vi.stubEnv('CANARY_ENABLED', 'false');
    vi.stubEnv('LOCATION_PING_SECRET', '');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    auth.isMobileAuthed.mockResolvedValue(true);
    await Promise.all([
      store.doc('agents', agentId).set({
        id: agentId,
        name: 'Owner Assistant',
        email: 'owner@example.test',
        calendarId: null,
        phoneE164: null,
        avatarUrl: null,
        signature: 'Owner signature',
        timezone: 'UTC',
        locale: 'en-US',
        workspacePrefix: 'owner',
        browserProfilePath: null,
        credentialRefs: {},
        createdAt: now,
        updatedAt: now,
      }),
      store.doc('contacts', ownerContactId).set({
        id: ownerContactId,
        name: 'Owner',
        trust: 'owner',
        aliases: [],
        relationship: '',
      }),
      store.doc('coordination', 'budget-policy').set({
        dailyLimitMicros: 5_000_000,
        monthlyLimitMicros: 50_000_000,
        softPct: 80,
      }),
      store.doc('agents', foreignAgentId).set({ id: foreignAgentId, name: 'Foreign' }),
    ]);
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllEnvs();
  });

  it('composes the native response from owner-scoped Firestore reads without SQL', async () => {
    const { getDb } = await import('./server.js');
    const { getFirestoreMobileWorkspace } = await import('./firestore-mobile-workspace.js');
    expect(() => getDb()).toThrow('PostgreSQL-backed web surface is unavailable');
    const source = {
      read: async () => ({ ready: true, database: 'firestore', modules: [] }),
    };
    const result = await getFirestoreMobileWorkspace(source);
    expect(result).toMatchObject({
      chats: { current: [], archived: [] },
      memory: { ownerName: 'Owner', ownerContactId, facts: [] },
      settings: { agent: { name: 'Owner Assistant' }, goalAutomationCount: 0 },
      costs: { dailySpentUsd: 0, monthlySpentUsd: 0, heldUsd: 0 },
      skills: [],
      anomalies: [],
      improvements: [],
      imports: { sources: [] },
    });
    expect(
      result.capabilities.every((capability) => !capability.enabled && !capability.ready),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain(foreignAgentId);

    const { GET } = await import('../app/api/mobile/v1/workspace/route.js');
    const response = await GET(new Request('http://localhost/api/mobile/v1/workspace'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      memory: { ownerContactId },
      settings: { agent: { name: 'Owner Assistant' } },
    });
  });

  it('refuses to return any section while privacy erasure is active', async () => {
    const { getFirestoreMobileWorkspace } = await import('./firestore-mobile-workspace.js');
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    await expect(getFirestoreMobileWorkspace({ read: async () => null })).rejects.toThrow(
      'Privacy erasure is in progress',
    );
  });

  it('requires mobile owner authentication at the GET route', async () => {
    const { GET } = await import('../app/api/mobile/v1/workspace/route.js');
    auth.isMobileAuthed.mockResolvedValueOnce(false);
    const unauthorized = await GET(new Request('http://localhost/api/mobile/v1/workspace'));
    expect(unauthorized.status).toBe(401);
  });
});
