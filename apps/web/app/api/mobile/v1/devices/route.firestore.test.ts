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

import { GET as ready } from '@/app/api/ready/route';
import { getDb } from '@/lib/server';
import { proxy } from '@/proxy';
import { POST as register } from './route';

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore device registration and readiness', () => {
  const installationId = `web-devices-${randomUUID()}`;
  const agentId = randomUUID();
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
  const token = 'cd'.repeat(32);

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
    await store.doc('agents', agentId).set({ id: agentId, name: 'Assistant' });
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  function post(body: unknown) {
    return register(
      new Request('http://localhost/api/mobile/v1/devices', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    );
  }

  it('opens the SQL-free routes in the proxy while PostgreSQL stays fenced', () => {
    expect(() => getDb()).toThrow('PostgreSQL-backed web surface is unavailable');
    const allowed: Array<[string, string]> = [
      ['/api/mobile/v1/devices', 'POST'],
      ['/api/ready', 'GET'],
      ['/api/live/scoreboard', 'GET'],
      ['/api/mobile/v1/live/scoreboard', 'GET'],
      ['/api/maps/snapshot', 'GET'],
      [`/profile/people/${randomUUID()}`, 'GET'],
    ];
    for (const [path, method] of allowed)
      expect(proxy(new NextRequest(`http://localhost${path}`, { method })).status).toBe(200);
    expect(
      proxy(new NextRequest('http://localhost/api/mobile/v1/devices', { method: 'DELETE' })).status,
    ).toBe(503);
  });

  it('registers the APNs token idempotently and rejects malformed tokens', async () => {
    expect((await post({ token, environment: 'sandbox' })).status).toBe(200);
    expect((await post({ token, environment: 'production' })).status).toBe(200);
    const rows = await store.collection('deviceTokens').get();
    expect(rows.docs.map((doc) => doc.data())).toEqual([
      expect.objectContaining({ agentId, token, environment: 'production', platform: 'ios' }),
    ]);

    const bad = await post({ token: 'not-hex' });
    expect(bad.status).toBe(400);
    auth.mobile.mockResolvedValueOnce(false);
    expect((await post({ token })).status).toBe(401);
  });

  it('reports readiness from the configured Firestore owner', async () => {
    const ok = await ready();
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ready: true, database: 'firestore' });

    await store.doc('agents', agentId).delete();
    const missing = await ready();
    expect(missing.status).toBe(503);
    expect(await missing.json()).toEqual({ ready: false, database: 'unavailable' });
  });
});
