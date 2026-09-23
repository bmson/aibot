import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore } from '@assistant/firestore';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ mobile: vi.fn() }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: auth.mobile,
  mobileJson: (body: unknown, init?: ResponseInit) =>
    Response.json(body, { ...init, headers: { 'cache-control': 'no-store' } }),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));

const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(
  process.env.FIRESTORE_EMULATOR_HOST ?? '',
);

describe.skipIf(!localEmulator)('Firestore mobile people mutations with PostgreSQL offline', () => {
  const installationId = `mobile-people-${randomUUID()}`;
  const agentId = randomUUID();
  const contactId = randomUUID();
  const foreignContactId = randomUUID();
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });

  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://offline:offline@127.0.0.1:1/offline_test');
    vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
    vi.stubEnv('GCP_PROJECT', 'demo-assistant-test');
    vi.stubEnv('ASSISTANT_WORKSPACE_ID', installationId);
    vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
    vi.stubEnv(
      'FIRESTORE_EMBEDDING_SPACE',
      '{"provider":"vertex","model":"example-embedding","dimensions":768,"revision":"fixture-v1"}',
    );
    vi.stubEnv('LLM_PROVIDER', 'vertex');
    vi.stubEnv('ASSISTANT_MODULES', 'minimal');
    vi.stubEnv('QUEUE_DRIVER', 'local');
    vi.stubEnv('CANARY_ENABLED', 'false');
    vi.stubEnv('LOCATION_PING_SECRET', '');
    resetConfigForTest();
    auth.mobile.mockResolvedValue(true);
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId, name: 'Assistant' }),
      store.doc('contacts', contactId).set({
        id: contactId,
        name: 'Rae',
        relationship: '',
        trust: 'unknown',
        aliases: [],
        emails: [],
        phones: [],
        notes: '',
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      store.doc('contacts', foreignContactId).set({
        id: foreignContactId,
        agentId: randomUUID(),
        name: 'Other owner',
        relationship: '',
        trust: 'unknown',
        aliases: [],
        emails: [],
        phones: [],
        notes: '',
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ]);
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  it('allows only POST collection and PATCH item mutations through the proxy', async () => {
    const { proxy } = await import('../../../../../../proxy.js');
    const status = (path: string, method: string) =>
      proxy(new NextRequest(`http://localhost${path}`, { method })).status;
    expect(status('/api/mobile/v1/memory/people', 'POST')).toBe(200);
    expect(status(`/api/mobile/v1/memory/people/${contactId}`, 'PATCH')).toBe(200);
    expect(status(`/api/mobile/v1/memory/people/${contactId}`, 'DELETE')).toBe(503);
    expect(status(`/api/mobile/v1/memory/people/${contactId}`, 'POST')).toBe(503);
    expect(status('/api/mobile/v1/memory/people/not-a-uuid', 'PATCH')).toBe(503);
  });

  it('creates and edits installation-owned people without opening PostgreSQL', async () => {
    const { POST } = await import('./route.js');
    const { getDb } = await import('@/lib/server');
    expect(() => getDb()).toThrow('PostgreSQL-backed web surface is unavailable');
    const created = await POST(
      new Request('http://localhost/api/mobile/v1/memory/people', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'New person', relationship: 'friend', aliases: 'N. P.' }),
      }),
    );
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody).toMatchObject({ contactId: expect.any(String) });
    expect((await store.doc('contacts', createdBody.contactId).get()).data()).toMatchObject({
      agentId,
      name: 'New person',
      relationship: 'friend',
      trust: 'known',
    });

    const { PATCH } = await import('./[id]/route.js');
    const updated = await PATCH(
      new Request(`http://localhost/api/mobile/v1/memory/people/${contactId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Rae New', relationship: 'colleague', aliases: '' }),
      }),
      { params: Promise.resolve({ id: contactId }) },
    );
    expect(updated.status).toBe(200);
    expect((await store.doc('contacts', contactId).get()).data()).toMatchObject({
      name: 'Rae New',
      relationship: 'colleague',
      trust: 'known',
      aliases: ['Rae'],
    });
    const foreign = await PATCH(
      new Request(`http://localhost/api/mobile/v1/memory/people/${foreignContactId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Attempted change', relationship: 'friend', aliases: '' }),
      }),
      { params: Promise.resolve({ id: foreignContactId }) },
    );
    expect(foreign.status).toBe(400);
    expect((await store.doc('contacts', foreignContactId).get()).get('name')).toBe('Other owner');
    expect(() => getDb()).toThrow('PostgreSQL-backed web surface is unavailable');
  });

  it('keeps whole-person merge and delete fail-closed', async () => {
    const { POST, DELETE } = await import('./[id]/route.js');
    const merge = await POST(
      new Request(`http://localhost/api/mobile/v1/memory/people/${contactId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'merge', targetId: foreignContactId }),
      }),
      { params: Promise.resolve({ id: contactId }) },
    );
    expect(merge.status).toBe(409);
    expect(await merge.json()).toEqual({
      error: 'Merging people is unavailable with Firestore persistence.',
    });
    const deleted = await DELETE(
      new Request(`http://localhost/api/mobile/v1/memory/people/${contactId}`, {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ id: contactId }) },
    );
    expect(deleted.status).toBe(409);
    expect(await deleted.json()).toEqual({
      error: 'Deleting people is unavailable with Firestore persistence.',
    });
    expect((await store.doc('contacts', contactId).get()).exists).toBe(true);
  });
});
