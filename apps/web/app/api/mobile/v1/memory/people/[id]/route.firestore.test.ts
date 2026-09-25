import { createHash, randomUUID } from 'node:crypto';
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
import { DELETE, POST } from './route';

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore mobile people delete and merge', () => {
  const installationId = `mobile-people-removal-${randomUUID()}`;
  const agentId = randomUUID();
  const ownerContactId = randomUUID();
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
      person(ownerContactId, 'Ada Owner', 'owner'),
    ]);
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  function person(id: string, name: string, trust = 'known', patch: Record<string, unknown> = {}) {
    return store.doc('contacts', id).set({
      id,
      agentId,
      name,
      trust,
      relationship: '',
      aliases: [],
      emails: [],
      phones: [],
      notes: '',
      createdAt: new Date('2026-09-01T00:00:00Z'),
      updatedAt: new Date('2026-09-01T00:00:00Z'),
      ...patch,
    });
  }

  async function fact(subjectContactId: string, content: string): Promise<string> {
    const id = randomUUID();
    const contentHash = createHash('sha256').update(content).digest('hex');
    await Promise.all([
      store.doc('memories', id).set({
        id,
        agentId,
        subjectContactId,
        content,
        contentHash,
        kind: 'fact',
        category: 'knowledge',
        confidence: '0.70',
        importance: 3,
        quarantined: false,
        ownerConfirmed: false,
        pinned: false,
        originTrust: 'known',
        supersededById: null,
        expiresAt: null,
        createdAt: new Date('2026-09-20T00:00:00Z'),
      }),
      store.doc('memoryContentHashes', contentHash).set({ memoryId: id }),
    ]);
    return id;
  }

  async function occasion(contactId: string, month: number, day: number) {
    const id = randomUUID();
    await store.doc('occasions', id).set({
      id,
      agentId,
      contactId,
      kind: 'birthday',
      label: 'Birthday',
      month,
      day,
      year: null,
      leadDays: 7,
      notes: '',
      updatedAt: new Date('2026-09-01T00:00:00Z'),
    });
    return id;
  }

  const del = (id: string) =>
    DELETE(
      new Request(`http://localhost/api/mobile/v1/memory/people/${id}`, { method: 'DELETE' }),
      {
        params: Promise.resolve({ id }),
      },
    );
  const merge = (id: string, targetId: string) =>
    POST(
      new Request(`http://localhost/api/mobile/v1/memory/people/${id}`, {
        method: 'POST',
        body: JSON.stringify({ action: 'merge', targetId }),
      }),
      { params: Promise.resolve({ id }) },
    );

  it('opens delete and merge in the proxy while PostgreSQL stays fenced', () => {
    expect(() => getDb()).toThrow('PostgreSQL-backed web surface is unavailable');
    const path = `/api/mobile/v1/memory/people/${randomUUID()}`;
    for (const method of ['POST', 'DELETE'])
      expect(proxy(new NextRequest(`http://localhost${path}`, { method })).status).toBe(200);
  });

  it('deletes a person, tombstones their facts, and clears their occasions and graph links', async () => {
    const graceId = randomUUID();
    await person(graceId, 'Grace Friend');
    const factIds = [await fact(graceId, 'Grace plays cello'), await fact(graceId, 'Grace is 40')];
    const kept = await fact(ownerContactId, 'Ada likes tea');
    await occasion(graceId, 3, 14);
    await store.doc('knowledgeGraphEntities', 'grace-entity').set({
      id: 'grace-entity',
      agentId,
      contactId: graceId,
      label: 'Grace',
    });

    const response = await del(graceId);
    expect(response.status).toBe(200);
    expect((await store.doc('contacts', graceId).get()).exists).toBe(false);
    for (const id of factIds) expect((await store.doc('memories', id).get()).exists).toBe(false);
    expect((await store.doc('memories', kept).get()).exists).toBe(true);
    const tombstones = await store.collection('memoryTombstones').get();
    expect(tombstones.docs.map((doc) => doc.get('reason'))).toEqual([
      'owner_delete_contact',
      'owner_delete_contact',
    ]);
    expect((await store.collection('occasions').where('contactId', '==', graceId).get()).size).toBe(
      0,
    );
    const entity = await store.doc('knowledgeGraphEntities', 'grace-entity').get();
    if (entity.exists) expect(entity.get('contactId')).toBeNull();
  });

  it('refuses to delete the owner or an unknown person', async () => {
    const owner = await del(ownerContactId);
    expect(owner.status).toBe(409);
    expect(await owner.json()).toEqual({ error: 'The owner profile cannot be deleted.' });
    const missing = await del(randomUUID());
    expect(missing.status).toBe(409);
    expect(await missing.json()).toEqual({ error: 'Person not found.' });
  });

  it('merges facts, non-duplicate occasions, and identity into the target', async () => {
    const sourceId = randomUUID();
    const targetId = randomUUID();
    await person(sourceId, 'Gracie', 'known', {
      aliases: ['G'],
      emails: ['grace@example.test'],
      relationship: 'friend',
      notes: 'Met at school',
    });
    await person(targetId, 'Grace Hopper', 'known', { emails: ['hopper@example.test'] });
    const moved = await fact(sourceId, 'Grace likes jazz');
    await occasion(sourceId, 3, 14);
    const duplicate = await occasion(sourceId, 12, 9);
    await occasion(targetId, 12, 9);

    const response = await merge(sourceId, targetId);
    expect(response.status).toBe(200);
    expect((await store.doc('contacts', sourceId).get()).exists).toBe(false);
    expect((await store.doc('memories', moved).get()).get('subjectContactId')).toBe(targetId);
    expect((await store.doc('occasions', duplicate).get()).exists).toBe(false);
    const targetOccasions = await store
      .collection('occasions')
      .where('contactId', '==', targetId)
      .get();
    expect(
      targetOccasions.docs.map((doc) => `${doc.get('month')}-${doc.get('day')}`).sort(),
    ).toEqual(['12-9', '3-14']);
    expect((await store.doc('contacts', targetId).get()).data()).toMatchObject({
      aliases: ['G', 'Gracie'],
      emails: ['hopper@example.test', 'grace@example.test'],
      relationship: 'friend',
      notes: 'Met at school',
    });
  });

  it('refuses to merge the owner away', async () => {
    const targetId = randomUUID();
    await person(targetId, 'Someone Else');
    const response = await merge(ownerContactId, targetId);
    expect(response.status).toBe(409);
    expect((await store.doc('contacts', ownerContactId).get()).exists).toBe(true);
  });
});
