import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore } from '@assistant/firestore';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ allowed: vi.fn() }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: auth.allowed,
  mobileJson: (value: unknown, init?: ResponseInit) => Response.json(value, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore mobile foreground wake signal', () => {
  const installationId = `mobile-foreground-${randomUUID()}`;
  const agentId = randomUUID();
  const scheduleId = randomUUID();
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
  let route: typeof import('./route.js');

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
    vi.setSystemTime(new Date('2026-09-23T12:00:00.000Z'));
    route = await import('./route.js');
    const now = new Date('2026-09-20T12:00:00.000Z');
    await Promise.all([
      store.doc('agents', agentId).set({
        id: agentId,
        name: 'Assistant',
        email: '',
        calendarId: null,
        phoneE164: null,
        avatarUrl: null,
        signature: '',
        timezone: 'America/Los_Angeles',
        locale: 'en-US',
        workspacePrefix: '',
        browserProfilePath: null,
        credentialRefs: null,
        createdAt: now,
        updatedAt: now,
      }),
      store.doc('schedules', scheduleId).set({
        id: scheduleId,
        agentId,
        name: 'daily-briefing',
        cron: '45 7 * * *',
        taskTemplate: { type: 'scheduled', budgetUsdLimit: '0.10', job: 'briefing.compose' },
        enabled: true,
        lastRunAt: null,
        nextRunAt: new Date('2026-09-23T14:45:00.000Z'),
        createdAt: now,
        updatedAt: now,
      }),
    ]);
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  it('allows authenticated POST only and safely rejects unauthenticated requests', async () => {
    const { proxy } = await import('../../../../../../proxy.js');
    expect(
      proxy(
        new NextRequest('http://localhost/api/mobile/v1/activity/foreground', { method: 'POST' }),
      ).status,
    ).toBe(200);
    expect(
      proxy(new NextRequest('http://localhost/api/mobile/v1/activity/foreground')).status,
    ).toBe(503);
    auth.allowed.mockResolvedValue(false);
    expect(
      (
        await route.POST(
          new Request('http://localhost/api/mobile/v1/activity/foreground', {
            method: 'POST',
          }),
        )
      ).status,
    ).toBe(401);
    auth.allowed.mockResolvedValue(true);
  });

  it('creates one durable wake task and deduplicates repeated foreground opens for the day', async () => {
    const request = () =>
      route.POST(
        new Request('http://localhost/api/mobile/v1/activity/foreground', { method: 'POST' }),
      );
    const first = await request();
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, wakeBriefFired: true });

    const second = await request();
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true, wakeBriefFired: false });

    const tasks = await store.collection('tasks').where('agentId', '==', agentId).get();
    expect(tasks.size).toBe(1);
    expect(tasks.docs[0]?.get('trigger')).toMatchObject({
      source: 'schedule',
      payload: { scheduleId, occurrenceId: `schedule:${scheduleId}:wake:2026-09-23` },
    });
    expect(tasks.docs[0]?.get('trigger')?.payload?.job).toBe('briefing.compose');
    const schedule = await store.doc('schedules', scheduleId).get();
    expect(schedule.get('lastRunAt').toDate().toISOString()).toBe('2026-09-23T12:00:00.000Z');
    const intents = await store
      .collection('outbox')
      .where('taskId', '==', tasks.docs[0]?.get('id'))
      .get();
    expect(intents.size).toBe(1);
  });

  it('fails closed during privacy erasure without creating another task', async () => {
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    const response = await route.POST(
      new Request('http://localhost/api/mobile/v1/activity/foreground', { method: 'POST' }),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('Privacy erasure is in progress');
    const tasks = await store.collection('tasks').where('agentId', '==', agentId).get();
    expect(tasks.size).toBe(1);
    await store.doc('privacyErasureJobs', agentId).delete();
  });
});
