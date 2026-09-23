import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore } from '@assistant/firestore';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ allowed: vi.fn() }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: auth.allowed,
  mobileJson: (value: unknown, init?: ResponseInit) => Response.json(value, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore mobile skill mutations with PostgreSQL offline', () => {
  const installationId = `mobile-skills-actions-${randomUUID()}`;
  const agentId = randomUUID();
  const otherAgentId = randomUUID();
  const skillId = randomUUID();
  const otherSkillId = randomUUID();
  const initial = new Date('2026-09-20T12:00:00Z');
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
  let route: typeof import('./route.js');
  let collectionRoute: typeof import('../route.js');

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
    route = await import('./route.js');
    collectionRoute = await import('../route.js');
  });

  beforeEach(async () => {
    auth.allowed.mockResolvedValue(true);
    await store.db.recursiveDelete(store.root);
    await store.doc('agents', agentId).set({ id: agentId });
    const skill = (id: string, owner: string) => ({
      id,
      agentId: owner,
      name: 'Test',
      preconditions: '',
      steps: 'Do it',
      gotchas: '',
      embedding: null,
      sourceTaskId: null,
      originTrust: 'owner',
      ownerAuthored: true,
      useCount: 0,
      successCount: 0,
      failureCount: 0,
      lastVerifiedAt: null,
      deprecated: false,
      createdAt: initial,
      updatedAt: initial,
    });
    await Promise.all([
      store.doc('skills', skillId).set(skill(skillId, agentId)),
      store.doc('skills', otherSkillId).set(skill(otherSkillId, otherAgentId)),
    ]);
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  const context = (id: string) => ({ params: Promise.resolve({ id }) });
  const post = (id: string, deprecated: unknown) =>
    route.POST(
      new Request(`http://localhost/api/mobile/v1/skills/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deprecated }),
      }),
      context(id),
    );
  const remove = (id: string) =>
    route.DELETE(
      new Request(`http://localhost/api/mobile/v1/skills/${id}`, { method: 'DELETE' }),
      context(id),
    );

  it('exposes only item deprecation and deletion through the Firestore proxy', async () => {
    const { proxy } = await import('../../../../../../proxy.js');
    for (const method of ['POST', 'DELETE'])
      expect(
        proxy(new NextRequest(`http://localhost/api/mobile/v1/skills/${skillId}`, { method }))
          .status,
      ).toBe(200);
    for (const method of ['PATCH', 'GET'])
      expect(
        proxy(new NextRequest(`http://localhost/api/mobile/v1/skills/${skillId}`, { method }))
          .status,
      ).toBe(503);
    expect(
      proxy(new NextRequest('http://localhost/api/mobile/v1/skills', { method: 'POST' })).status,
    ).toBe(503);
    expect(
      proxy(
        new NextRequest('http://localhost/api/mobile/v1/skills/not-a-uuid', { method: 'DELETE' }),
      ).status,
    ).toBe(503);
  });

  it('toggles deprecation and hard-deletes the owner skill', async () => {
    expect((await post(skillId, true)).status).toBe(200);
    let skill = await store.doc('skills', skillId).get();
    expect(skill.get('deprecated')).toBe(true);
    expect(skill.get('updatedAt').toDate().getTime()).toBeGreaterThan(initial.getTime());
    expect((await post(skillId, false)).status).toBe(200);
    skill = await store.doc('skills', skillId).get();
    expect(skill.get('deprecated')).toBe(false);
    expect((await remove(skillId)).status).toBe(200);
    expect((await store.doc('skills', skillId).get()).exists).toBe(false);
  });

  it('rejects missing, foreign, malformed, and ambiguous records without deleting them', async () => {
    expect((await remove(randomUUID())).status).toBe(409);
    expect((await remove(otherSkillId)).status).toBe(409);
    expect((await store.doc('skills', otherSkillId).get()).exists).toBe(true);
    await store.doc('skills', skillId).update({ steps: 42 });
    expect((await post(skillId, true)).status).toBe(409);
    expect((await store.doc('skills', skillId).get()).get('deprecated')).toBe(false);
    await store.doc('agents', otherAgentId).set({ id: otherAgentId });
    expect((await remove(skillId)).status).toBe(409);
    expect((await store.doc('skills', skillId).get()).exists).toBe(true);
  });

  it('respects the privacy-erasure fence and auth and validates input', async () => {
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    expect((await remove(skillId)).status).toBe(409);
    expect((await store.doc('skills', skillId).get()).exists).toBe(true);
    await store.doc('privacyErasureJobs', agentId).delete();
    expect((await post(skillId, 'yes')).status).toBe(400);
    auth.allowed.mockResolvedValueOnce(false);
    expect((await remove(skillId)).status).toBe(401);
  });

  it('blocks direct create and edit route calls without PostgreSQL', async () => {
    const create = await collectionRoute.POST(
      new Request('http://localhost/api/mobile/v1/skills', { method: 'POST' }),
    );
    expect(create.status).toBe(503);
    const edit = await route.PATCH(
      new Request(`http://localhost/api/mobile/v1/skills/${skillId}`, { method: 'PATCH' }),
      context(skillId),
    );
    expect(edit.status).toBe(503);
  });
});
