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

describe.skipIf(!localEmulator)('Firestore mobile Goals reads with PostgreSQL offline', () => {
  const installationId = `mobile-goals-${randomUUID()}`;
  const agentId = randomUUID();
  const otherAgentId = randomUUID();
  const currentId = randomUUID();
  const archivedId = randomUUID();
  const foreignId = randomUUID();
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
  let listRoute: typeof import('./route.js');
  let detailRoute: typeof import('./[id]/route.js');
  const now = new Date('2026-09-22T12:00:00Z');
  const goal = (id: string, patch: Record<string, unknown> = {}) => ({
    id,
    agentId,
    title: `Goal ${id}`,
    description: 'Details',
    status: 'active',
    priority: 2,
    progress: 'Halfway',
    nextAction: 'Keep going',
    targetDate: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    mirrorToPrimary: false,
    autonomy: false,
    taintedOrigin: false,
    ...patch,
  });

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
    auth.allowed.mockResolvedValue(true);
    listRoute = await import('./route.js');
    detailRoute = await import('./[id]/route.js');
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId }),
      store.doc('goals', currentId).set(goal(currentId)),
      store.doc('goals', archivedId).set(goal(archivedId, { archivedAt: now })),
      store.doc('goals', foreignId).set(goal(foreignId, { agentId: otherAgentId })),
      store.doc('conversations', 'goal-chat').set({
        id: 'goal-chat',
        agentId,
        channel: 'chat',
        updatedAt: now,
        metadata: { goalId: currentId },
      }),
      store.doc('tasks', 'goal-task').set({
        id: 'goal-task',
        agentId,
        goalId: currentId,
        status: 'running',
        updatedAt: now,
      }),
      store.doc('schedules', 'goal-schedule').set({
        id: 'goal-schedule',
        agentId,
        name: `goal:${currentId}`,
        enabled: true,
        nextRunAt: now,
      }),
    ]);
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  it('allows only owner-authenticated GET list/detail through the Firestore proxy', async () => {
    const { proxy } = await import('../../../../../proxy.js');
    expect(proxy(new NextRequest('http://localhost/api/mobile/v1/goals')).status).toBe(200);
    expect(
      proxy(new NextRequest('http://localhost/api/mobile/v1/goals', { method: 'POST' })).status,
    ).toBe(503);
    expect(
      proxy(new NextRequest(`http://localhost/api/mobile/v1/goals/${randomUUID()}`)).status,
    ).toBe(200);
    expect(
      proxy(
        new NextRequest(`http://localhost/api/mobile/v1/goals/${randomUUID()}`, {
          method: 'PATCH',
        }),
      ).status,
    ).toBe(503);
    auth.allowed.mockResolvedValue(false);
    expect((await listRoute.GET(new Request('http://localhost/api/mobile/v1/goals'))).status).toBe(
      401,
    );
    auth.allowed.mockResolvedValue(true);
  });

  it('returns the owned dashboard projections and archived count without SQL', async () => {
    const response = await listRoute.GET(new Request('http://localhost/api/mobile/v1/goals'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      archivedCount: 1,
      items: [
        {
          goal: { id: currentId },
          conversationId: 'goal-chat',
          workActive: true,
          automation: { enabled: true, nextRunAt: now.toISOString() },
          cadenceLabel: 'daily',
        },
      ],
    });
    expect(body.items.map((item: { goal: { id: string } }) => item.goal.id)).not.toContain(
      foreignId,
    );
    const archived = await listRoute.GET(
      new Request('http://localhost/api/mobile/v1/goals?archived=true'),
    );
    expect(
      (await archived.json()).items.map((item: { goal: { id: string } }) => item.goal.id),
    ).toEqual([archivedId]);
  });

  it('returns only a configured-owner goal from the detail route', async () => {
    const found = await detailRoute.GET(
      new Request(`http://localhost/api/mobile/v1/goals/${currentId}`),
      { params: Promise.resolve({ id: currentId }) },
    );
    expect(found.status).toBe(200);
    expect(await found.json()).toMatchObject({ goal: { id: currentId, agentId } });
    const foreign = await detailRoute.GET(
      new Request(`http://localhost/api/mobile/v1/goals/${foreignId}`),
      { params: Promise.resolve({ id: foreignId }) },
    );
    expect(foreign.status).toBe(404);
    const malformed = await detailRoute.GET(
      new Request('http://localhost/api/mobile/v1/goals/bad'),
      { params: Promise.resolve({ id: 'bad' }) },
    );
    expect(malformed.status).toBe(400);
  });
});
