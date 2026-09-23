import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore, FirestoreScheduleRepository } from '@assistant/firestore';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { deletePolicy, setPolicyEnabled, setScheduleEnabled } from './actions';

const mocks = vi.hoisted(() => ({
  owner: vi.fn(),
  mobile: vi.fn(),
  application: vi.fn(),
  store: null as unknown,
}));
vi.mock('@/auth', () => ({ requireOwner: mocks.owner }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: mocks.mobile,
  mobileJson: (body: unknown, init?: ResponseInit) =>
    Response.json(body, { ...init, headers: { 'cache-control': 'no-store' } }),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/server', () => ({
  getApplication: mocks.application,
  getFirestoreInstallationStore: () => mocks.store,
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(
  process.env.FIRESTORE_EMULATOR_HOST ?? '',
);

describe.skipIf(!localEmulator)('Firestore settings controls with PostgreSQL offline', () => {
  const installationId = `settings-controls-${randomUUID()}`;
  const databaseId = `settings-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const agentId = randomUUID();
  const foreignId = randomUUID();
  let ownScheduleId = '';
  let foreignScheduleId = '';
  const ownPolicyId = randomUUID();
  const foreignPolicyId = randomUUID();
  const store = createInstallationStore({
    projectId: 'demo-assistant-test',
    installationId,
    databaseId,
  });
  const schedules = new FirestoreScheduleRepository(store);
  const now = new Date('2026-09-23T12:00:00.000Z');

  beforeAll(async () => {
    vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
    vi.stubEnv('DATABASE_URL', 'postgres://offline:offline@127.0.0.1:1/offline_test');
    vi.stubEnv('GCP_PROJECT', 'demo-assistant-test');
    vi.stubEnv('ASSISTANT_WORKSPACE_ID', installationId);
    vi.stubEnv('FIRESTORE_DATABASE_ID', databaseId);
    vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
    vi.stubEnv(
      'FIRESTORE_EMBEDDING_SPACE',
      '{"provider":"vertex","model":"fixture","dimensions":1536,"revision":"1"}',
    );
    vi.stubEnv('ASSISTANT_MODULES', 'minimal');
    vi.stubEnv('QUEUE_DRIVER', 'local');
    vi.stubEnv('CANARY_ENABLED', 'false');
    vi.stubEnv('LOCATION_PING_SECRET', '');
    resetConfigForTest();
    mocks.store = store;
    mocks.application.mockImplementation(() => {
      throw new Error('PostgreSQL application must not be opened');
    });
  });

  beforeEach(async () => {
    mocks.owner.mockResolvedValue(undefined);
    mocks.mobile.mockResolvedValue(true);
    await store.db.recursiveDelete(store.root);
    await store.doc('agents', agentId).set({
      id: agentId,
      name: 'Owner',
      timezone: 'UTC',
      locale: 'en-US',
      signature: '',
      createdAt: now,
      updatedAt: now,
    });
    const ownSchedule = await schedules.ensure({
      agentId,
      name: 'daily-job',
      cron: '0 9 * * *',
      taskTemplate: {},
      nextRunAt: now,
    });
    const foreignSchedule = await schedules.ensure({
      agentId: foreignId,
      name: 'foreign-job',
      cron: '0 9 * * *',
      taskTemplate: {},
      nextRunAt: now,
    });
    ownScheduleId = ownSchedule.id;
    foreignScheduleId = foreignSchedule.id;
    const policy = (id: string, ownerId: string) => ({
      id,
      agentId: ownerId,
      toolName: 'calendar.create_event',
      templateKey: 'always-ask',
      effect: 'ask',
      enabled: true,
      createdVia: 'owner',
      match: {},
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    await Promise.all([
      store.doc('approvalPolicies', ownPolicyId).set(policy(ownPolicyId, agentId)),
      store.doc('approvalPolicies', foreignPolicyId).set(policy(foreignPolicyId, foreignId)),
    ]);
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  it('updates only owner schedules and policies through web controls', async () => {
    await setScheduleEnabled(ownScheduleId, false);
    expect((await store.doc('schedules', ownScheduleId).get()).get('enabled')).toBe(false);
    await setScheduleEnabled(foreignScheduleId, false);
    expect((await store.doc('schedules', foreignScheduleId).get()).get('enabled')).toBe(true);

    await setPolicyEnabled(ownPolicyId, false);
    expect((await store.doc('approvalPolicies', ownPolicyId).get()).get('enabled')).toBe(false);
    await setPolicyEnabled(foreignPolicyId, false);
    expect((await store.doc('approvalPolicies', foreignPolicyId).get()).get('enabled')).toBe(true);
    await deletePolicy(ownPolicyId);
    expect((await store.doc('approvalPolicies', ownPolicyId).get()).exists).toBe(false);
    expect((await store.doc('approvalPolicies', foreignPolicyId).get()).exists).toBe(true);
    expect(mocks.application).not.toHaveBeenCalled();
  });

  it('fails closed for active erasure and a non-sole configured owner', async () => {
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    await expect(setPolicyEnabled(ownPolicyId, false)).rejects.toThrow(
      'Privacy erasure is in progress',
    );
    expect((await store.doc('approvalPolicies', ownPolicyId).get()).get('enabled')).toBe(true);
    await store.doc('privacyErasureJobs', agentId).delete();
    await store.doc('agents', foreignId).set({ id: foreignId, name: 'Unexpected owner' });
    await expect(setScheduleEnabled(ownScheduleId, false)).rejects.toThrow(
      'exactly one configured agent',
    );
    expect((await store.doc('schedules', ownScheduleId).get()).get('enabled')).toBe(true);
  });

  it('opens only the authenticated mobile mutations in the Firestore proxy', async () => {
    const { proxy } = await import('../../proxy.js');
    const status = (path: string, method: string) =>
      proxy(new NextRequest(`http://localhost${path}`, { method })).status;
    expect(status(`/api/mobile/v1/settings/policies/${ownPolicyId}`, 'POST')).toBe(200);
    expect(status(`/api/mobile/v1/settings/policies/${ownPolicyId}`, 'DELETE')).toBe(200);
    expect(status(`/api/mobile/v1/settings/schedules/${ownScheduleId}`, 'POST')).toBe(200);
    expect(status(`/api/mobile/v1/settings/policies/not-a-uuid`, 'POST')).toBe(503);
    expect(status(`/api/mobile/v1/settings/schedules/${ownScheduleId}`, 'DELETE')).toBe(503);
  });

  it('applies authenticated mobile policy and schedule mutations in Firestore', async () => {
    const { POST: setPolicy } = await import('../api/mobile/v1/settings/policies/[id]/route.js');
    const { DELETE: removePolicy } = await import(
      '../api/mobile/v1/settings/policies/[id]/route.js'
    );
    const { POST: setSchedule } = await import('../api/mobile/v1/settings/schedules/[id]/route.js');
    const request = (method: string, body?: unknown) =>
      new Request('http://localhost/mobile-settings', {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    expect(
      (
        await setPolicy(request('POST', { enabled: false }), {
          params: Promise.resolve({ id: ownPolicyId }),
        })
      ).status,
    ).toBe(200);
    expect((await store.doc('approvalPolicies', ownPolicyId).get()).get('enabled')).toBe(false);
    expect(
      (
        await setPolicy(request('POST', { enabled: false }), {
          params: Promise.resolve({ id: foreignPolicyId }),
        })
      ).status,
    ).toBe(200);
    expect((await store.doc('approvalPolicies', foreignPolicyId).get()).get('enabled')).toBe(true);
    expect(
      (
        await setSchedule(request('POST', { enabled: false }), {
          params: Promise.resolve({ id: ownScheduleId }),
        })
      ).status,
    ).toBe(200);
    expect((await store.doc('schedules', ownScheduleId).get()).get('enabled')).toBe(false);
    expect(
      (await removePolicy(request('DELETE'), { params: Promise.resolve({ id: ownPolicyId }) }))
        .status,
    ).toBe(200);
    expect((await store.doc('approvalPolicies', ownPolicyId).get()).exists).toBe(false);

    mocks.mobile.mockResolvedValueOnce(false);
    expect(
      (
        await setSchedule(request('POST', { enabled: false }), {
          params: Promise.resolve({ id: ownScheduleId }),
        })
      ).status,
    ).toBe(401);
    expect(mocks.application).not.toHaveBeenCalled();
  });
});
