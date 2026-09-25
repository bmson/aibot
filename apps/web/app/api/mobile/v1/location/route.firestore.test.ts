import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore } from '@assistant/firestore';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ mobile: vi.fn() }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: auth.mobile,
  mobileJson: (body: unknown, init?: ResponseInit) => Response.json(body, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), unstable_cache: (run: unknown) => run }));

import { getDb } from '@/lib/server';
import { proxy } from '@/proxy';
import { POST as ping } from './route';

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore mobile location pings with PostgreSQL offline', () => {
  const installationId = `web-location-${randomUUID()}`;
  const agentId = randomUUID();
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });

  beforeAll(() => {
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
    vi.stubEnv('VERTEX_PROJECT', 'demo-assistant-test');
    vi.stubEnv('VERTEX_LOCATION', 'us-central1');
    vi.stubEnv('ASSISTANT_MODULES', 'minimal');
    vi.stubEnv('QUEUE_DRIVER', 'local');
    vi.stubEnv('CANARY_ENABLED', 'false');
    resetConfigForTest();
  });

  beforeEach(async () => {
    auth.mobile.mockResolvedValue(true);
    await store.db.recursiveDelete(store.root);
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId, name: 'Assistant', timezone: 'UTC' }),
      store.doc('rateLimits', 'task').set({ perHour: null, perDay: null }),
    ]);
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  function post(body: unknown) {
    return ping(
      new Request('http://localhost/api/mobile/v1/location', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    );
  }

  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

  async function seedPing(lat: number, lng: number, capturedAt: Date) {
    const id = randomUUID();
    await store.doc('locationPings', id).set({
      id,
      agentId,
      source: 'app',
      label: '',
      lat: String(lat),
      lng: String(lng),
      accuracyM: 20,
      timeZone: null,
      capturedAt,
      createdAt: capturedAt,
    });
  }

  async function arrivalTasks() {
    return (await store.collection('tasks').where('agentId', '==', agentId).get()).docs
      .map((doc) => doc.data())
      .filter((row) => String(row.externalEventId).startsWith(`arrival:${agentId}:`));
  }

  it('passes the proxy and records a fresh ping without PostgreSQL', async () => {
    expect(() => getDb()).toThrow('PostgreSQL-backed web surface is unavailable');
    expect(
      proxy(new NextRequest('http://localhost/api/mobile/v1/location', { method: 'POST' })).status,
    ).toBe(200);
    const response = await post({
      lat: 64.14,
      lng: -21.94,
      accuracyM: 30,
      source: 'app',
      capturedAt: new Date().toISOString(),
    });
    expect(response.status).toBe(200);
    const rows = (await store.collection('locationPings').get()).docs.map((doc) => doc.data());
    expect(rows).toEqual([expect.objectContaining({ agentId, lat: '64.14', source: 'app' })]);
    expect(await arrivalTasks()).toEqual([]);
  });

  it('rejects stale and malformed pings', async () => {
    expect((await post({ lat: 1, lng: 1, capturedAt: minutesAgo(30).toISOString() })).status).toBe(
      409,
    );
    expect((await post({ lat: 500, lng: 1, capturedAt: new Date().toISOString() })).status).toBe(
      400,
    );
    expect((await store.collection('locationPings').get()).size).toBe(0);
  });

  it('enqueues one arrival nudge after a confirmed stop somewhere new', async () => {
    // Routine baseline far away earlier today, then a confirming fix here.
    await seedPing(51.5, -0.12, minutesAgo(600));
    await seedPing(64.14, -21.94, minutesAgo(5));
    const body = {
      lat: 64.1401,
      lng: -21.9401,
      accuracyM: 20,
      label: 'Harbour',
      source: 'app',
      capturedAt: new Date().toISOString(),
    };
    expect((await post(body)).status).toBe(200);
    const tasks = await arrivalTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ trust: 'assistant', type: 'adhoc', status: 'pending' });

    // The cooldown keeps a second stop from adding another nudge.
    expect((await post({ ...body, capturedAt: new Date().toISOString() })).status).toBe(200);
    expect(await arrivalTasks()).toHaveLength(1);
  });
});
