import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore } from '@assistant/firestore';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ allowed: vi.fn(), sqlCalls: vi.fn() }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: auth.allowed,
  mobileJson: (value: unknown, init?: ResponseInit) =>
    Response.json(value, { ...init, headers: { 'cache-control': 'no-store' } }),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/server', async () => {
  const actual = await vi.importActual<typeof import('@/lib/server')>('@/lib/server');
  return {
    ...actual,
    getDb: () => {
      auth.sqlCalls();
      throw new Error('PostgreSQL must be unreachable for Firestore goal mutations');
    },
  };
});

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore mobile Goals routes with PostgreSQL offline', () => {
  const installationId = `mobile-goals-${randomUUID()}`;
  const agentId = randomUUID();
  const otherAgentId = randomUUID();
  const currentId = randomUUID();
  const archivedId = randomUUID();
  const foreignId = randomUUID();
  const scheduleId = 'goal-schedule';
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
      store
        .doc('goals', archivedId)
        .set(goal(archivedId, { archivedAt: now, taintedOrigin: true })),
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
      store.doc('tasks', 'goal-queued-task').set({
        id: 'goal-queued-task',
        agentId,
        goalId: currentId,
        status: 'pending',
        updatedAt: now,
        progress: '',
        runAfter: now,
        lockedUntil: null,
      }),
      store.doc('schedules', scheduleId).set({
        id: scheduleId,
        agentId,
        name: `goal:${currentId}`,
        cron: '15 9 * * *',
        taskTemplate: {
          type: 'scheduled',
          goalId: currentId,
          conversationId: 'goal-chat',
          instruction: 'old',
        },
        enabled: true,
        nextRunAt: now,
        lastRunAt: null,
        createdAt: now,
        updatedAt: now,
      }),
      store.doc('schedules', `schedule-${archivedId}`).set({
        id: `schedule-${archivedId}`,
        agentId,
        name: `goal:${archivedId}`,
        cron: '15 9 * * *',
        taskTemplate: {
          type: 'scheduled',
          goalId: archivedId,
          conversationId: 'goal-chat',
          instruction: 'old',
        },
        enabled: false,
        nextRunAt: null,
        lastRunAt: null,
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
    ).toBe(200);
    expect(
      proxy(
        new NextRequest(`http://localhost/api/mobile/v1/goals/${randomUUID()}`, {
          method: 'POST',
        }),
      ).status,
    ).toBe(200);
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

  it('updates settings and schedule through Firestore without SQL', async () => {
    const response = await detailRoute.PATCH(
      new Request(`http://localhost/api/mobile/v1/goals/${currentId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Updated owner goal',
          priority: 2,
          description: 'Context',
          targetDate: '2026-12-01',
          progress: 'Progress',
          nextAction: 'Continue',
          mirrorToPrimary: true,
        }),
      }),
      { params: Promise.resolve({ id: currentId }) },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await store.doc('goals', currentId).get()).get('title')).toBe('Updated owner goal');
    const schedule = await store.doc('schedules', scheduleId).get();
    expect(schedule.get('cron')).toBe('15 9 * * *');
    expect(schedule.get('nextRunAt')).toBeNull();
    expect(schedule.get('taskTemplate.instruction')).toContain('Updated owner goal');
    expect(auth.sqlCalls).not.toHaveBeenCalled();
  });

  it('supports owner lifecycle and autonomy mutations while rejecting unsafe or foreign cases', async () => {
    const action = (id: string, body: unknown) =>
      detailRoute.POST(
        new Request(`http://localhost/api/mobile/v1/goals/${id}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id }) },
      );
    const autonomyResponse = await action(currentId, { action: 'autonomy', enabled: true });
    expect(autonomyResponse.status, await autonomyResponse.clone().text()).toBe(200);
    expect((await store.doc('goals', currentId).get()).get('autonomy')).toBe(true);
    expect((await action(archivedId, { action: 'autonomy', enabled: true })).status).toBe(409);
    expect((await action(foreignId, { action: 'status', status: 'paused' })).status).toBe(409);
    expect((await store.doc('goals', foreignId).get()).get('status')).toBe('active');
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    expect((await action(currentId, { action: 'autonomy', enabled: false })).status).toBe(409);
    expect((await store.doc('goals', currentId).get()).get('autonomy')).toBe(true);
    await store.doc('privacyErasureJobs', agentId).delete();
    expect((await action('bad', { action: 'status', status: 'paused' })).status).toBe(400);
    expect((await action(currentId, { action: 'archive' })).status).toBe(409);
    expect((await action(currentId, { action: 'status', status: 'abandoned' })).status).toBe(200);
    expect((await store.doc('tasks', 'goal-queued-task').get()).get('status')).toBe('cancelled');
    expect((await store.doc('tasks', 'goal-task').get()).get('status')).toBe('running');
    expect((await action(currentId, { action: 'status', status: 'paused' })).status).toBe(200);
    expect((await store.doc('schedules', scheduleId).get()).get('enabled')).toBe(false);
    await store.doc('tasks', 'goal-task').update({ status: 'done' });
    const archiveAfterStop = await action(currentId, { action: 'archive' });
    expect(archiveAfterStop.status).toBe(200);
    expect((await action(archivedId, { action: 'restore' })).status).toBe(200);
    expect((await store.doc('goals', archivedId).get()).get('archivedAt')).toBeNull();
    expect((await store.doc('schedules', `schedule-${archivedId}`).get()).get('enabled')).toBe(
      true,
    );
    expect((await action(currentId, { action: 'start' })).status).toBe(503);
    expect(auth.sqlCalls).not.toHaveBeenCalled();
  });

  it('keeps collection create and archive-inactive explicitly unavailable on Firestore', async () => {
    const create = await listRoute.POST(
      new Request('http://localhost/api/mobile/v1/goals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'New goal' }),
      }),
    );
    expect(create.status).toBe(503);
    const archiveInactive = await listRoute.POST(
      new Request('http://localhost/api/mobile/v1/goals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'archive-inactive' }),
      }),
    );
    expect(archiveInactive.status).toBe(503);
    expect(auth.sqlCalls).not.toHaveBeenCalled();
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
