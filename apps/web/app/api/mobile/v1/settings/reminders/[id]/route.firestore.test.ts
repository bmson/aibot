import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore } from '@assistant/firestore';
import { taskFixture } from '@assistant/persistence/testing';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), application: vi.fn(), store: null as unknown }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: mocks.auth,
  mobileJson: (value: unknown, init?: ResponseInit) =>
    Response.json(value, { ...init, headers: { 'cache-control': 'no-store' } }),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/server', () => ({
  getApplication: mocks.application,
  getFirestoreInstallationStore: () => mocks.store,
}));

const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(
  process.env.FIRESTORE_EMULATOR_HOST ?? '',
);

describe.skipIf(!localEmulator)(
  'Firestore mobile reminder deletion with PostgreSQL offline',
  () => {
    const installationId = `mobile-reminder-delete-${randomUUID()}`;
    const agentId = randomUUID();
    const reminderId = randomUUID();
    const foreignReminderId = randomUUID();
    const taskId = randomUUID();
    const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
    const request = (id = reminderId) =>
      new Request(`http://localhost/api/mobile/v1/settings/reminders/${id}`, { method: 'DELETE' });
    let DELETE: typeof import('./route.js').DELETE;

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
      mocks.store = store;
      mocks.auth.mockResolvedValue(true);
      mocks.application.mockImplementation(() => {
        throw new Error('PostgreSQL application must not be opened');
      });
      ({ DELETE } = await import('./route.js'));
      await store.doc('agents', agentId).set({ id: agentId });
    });

    afterAll(async () => {
      await store.db.recursiveDelete(store.root);
      await store.db.terminate();
      vi.unstubAllEnvs();
      resetConfigForTest();
    });

    const putReminder = async (id: string, ownerId = agentId) => {
      await store.doc('schedules', id).set({
        id,
        agentId: ownerId,
        name: `reminder:${id}`,
        cron: '0 9 * * *',
        enabled: true,
        nextRunAt: new Date(Date.now() + 3_600_000),
        taskTemplate: { reminderKind: 'recurring', reminderText: 'Call Sam' },
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    };

    it('opens only the authenticated DELETE for an exact reminder UUID', async () => {
      const { proxy } = await import('../../../../../../../proxy.js');
      const status = (path: string, method = 'DELETE') =>
        proxy(new NextRequest(`http://localhost${path}`, { method })).status;
      expect(status(`/api/mobile/v1/settings/reminders/${reminderId}`)).toBe(200);
      expect(status(`/api/mobile/v1/settings/reminders/${reminderId}`, 'GET')).toBe(503);
      expect(status('/api/mobile/v1/settings/reminders/not-a-uuid')).toBe(503);
      mocks.auth.mockResolvedValueOnce(false);
      expect(
        (await DELETE(request(), { params: Promise.resolve({ id: reminderId }) })).status,
      ).toBe(401);
    });

    it('retains the PostgreSQL application delete path for signed-in mobile clients', async () => {
      vi.stubEnv('PERSISTENCE_DRIVER', 'postgres');
      resetConfigForTest();
      const deleteReminder = vi.fn().mockResolvedValue(true);
      mocks.application.mockReturnValue({ deleteReminder });
      const response = await DELETE(request(), { params: Promise.resolve({ id: reminderId }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(deleteReminder).toHaveBeenCalledWith(reminderId);
      vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
      resetConfigForTest();
      mocks.application.mockImplementation(() => {
        throw new Error('PostgreSQL application must not be opened');
      });
    });

    it('cancels only the owner reminder and its queued delivery task', async () => {
      await Promise.all([
        putReminder(reminderId),
        putReminder(foreignReminderId, randomUUID()),
        store.doc('tasks', taskId).set({
          ...taskFixture({ id: taskId, agentId, conversationId: randomUUID(), reminderId }),
          trigger: { payload: { scheduleId: reminderId } },
        }),
      ]);

      const response = await DELETE(request(), { params: Promise.resolve({ id: reminderId }) });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ ok: true });
      const cancelled = await store.doc('schedules', reminderId).get();
      expect(cancelled.data()).toMatchObject({ enabled: false, nextRunAt: null });
      expect(cancelled.get('taskTemplate')).toMatchObject({
        reminderKind: 'recurring',
        reminderCancelledAt: expect.any(String),
      });
      expect((await store.doc('tasks', taskId).get()).data()).toMatchObject({
        status: 'cancelled',
        runAfter: null,
        leaseToken: null,
      });

      const foreignResponse = await DELETE(request(foreignReminderId), {
        params: Promise.resolve({ id: foreignReminderId }),
      });
      expect(foreignResponse.status).toBe(404);
      expect((await store.doc('schedules', foreignReminderId).get()).get('enabled')).toBe(true);
    });

    it('returns 404 for missing or inactive reminders and rejects an erasure fence', async () => {
      expect(
        (await DELETE(request(), { params: Promise.resolve({ id: reminderId }) })).status,
      ).toBe(404);
      await putReminder(reminderId);
      await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
      await expect(
        DELETE(request(), { params: Promise.resolve({ id: reminderId }) }),
      ).rejects.toThrow('Privacy erasure is in progress');
      expect((await store.doc('schedules', reminderId).get()).get('enabled')).toBe(true);
      await store.doc('privacyErasureJobs', agentId).delete();
      await store.doc('schedules', reminderId).update({
        enabled: false,
        taskTemplate: { reminderKind: 'recurring', reminderCancelledAt: new Date().toISOString() },
      });
      expect(
        (await DELETE(request(), { params: Promise.resolve({ id: reminderId }) })).status,
      ).toBe(404);
    });

    it('fails closed if the installation does not have exactly one matching owner', async () => {
      vi.stubEnv('FIRESTORE_AGENT_ID', randomUUID());
      resetConfigForTest();
      await expect(
        DELETE(request(), { params: Promise.resolve({ id: reminderId }) }),
      ).rejects.toThrow('exactly one configured agent');
      vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
      resetConfigForTest();
    });
  },
);
