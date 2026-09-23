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

describe.skipIf(!localEmulator)(
  'Firestore mobile Activity archive/restore with PostgreSQL offline',
  () => {
    const installationId = `mobile-activity-actions-${randomUUID()}`;
    const agentId = randomUUID();
    const foreignAgentId = randomUUID();
    const doneId = randomUUID();
    const runningId = randomUUID();
    const foreignId = randomUUID();
    const initial = new Date('2026-09-20T12:00:00Z');
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
      route = await import('./route.js');
    });

    beforeEach(async () => {
      auth.allowed.mockResolvedValue(true);
      await Promise.all([
        store.doc('agents', agentId).set({ id: agentId }),
        store
          .doc('tasks', doneId)
          .set({ id: doneId, agentId, status: 'done', archivedAt: null, updatedAt: initial }),
        store
          .doc('tasks', runningId)
          .set({ id: runningId, agentId, status: 'running', archivedAt: null, updatedAt: initial }),
        store.doc('tasks', foreignId).set({
          id: foreignId,
          agentId: foreignAgentId,
          status: 'done',
          archivedAt: null,
          updatedAt: initial,
        }),
      ]);
    });

    afterAll(async () => {
      await store.db.recursiveDelete(store.root);
      await store.db.terminate();
      vi.unstubAllEnvs();
      resetConfigForTest();
    });

    const post = (id: string, action: string) =>
      route.POST(
        new Request(`http://localhost/api/mobile/v1/activity/${id}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action }),
        }),
        { params: Promise.resolve({ id }) },
      );

    it('allows only the scoped POST route through the proxy', async () => {
      const { proxy } = await import('../../../../../../proxy.js');
      expect(
        proxy(
          new NextRequest(`http://localhost/api/mobile/v1/activity/${doneId}`, { method: 'POST' }),
        ).status,
      ).toBe(200);
      expect(
        proxy(new NextRequest(`http://localhost/api/mobile/v1/activity/${doneId}`)).status,
      ).toBe(503);
      expect(
        proxy(new NextRequest('http://localhost/api/mobile/v1/activity', { method: 'POST' }))
          .status,
      ).toBe(200);
      expect(
        proxy(
          new NextRequest('http://localhost/api/mobile/v1/activity/not-a-uuid', { method: 'POST' }),
        ).status,
      ).toBe(503);
    });

    it('archives a terminal owner task and restores it atomically', async () => {
      expect((await post(doneId, 'archive')).status).toBe(200);
      const archived = await store.doc('tasks', doneId).get();
      const archivedAt = archived.get('archivedAt').toDate();
      expect(archivedAt).toBeInstanceOf(Date);
      expect(archived.get('updatedAt').toDate().getTime()).toBe(archivedAt.getTime());

      expect((await post(doneId, 'archive')).status).toBe(200);
      expect((await store.doc('tasks', doneId).get()).get('archivedAt').toDate()).toEqual(
        archivedAt,
      );

      expect((await post(doneId, 'restore')).status).toBe(200);
      const restored = await store.doc('tasks', doneId).get();
      expect(restored.get('archivedAt')).toBeNull();
      expect(restored.get('updatedAt').toDate().getTime()).toBeGreaterThanOrEqual(
        archivedAt.getTime(),
      );
    });

    it('refuses non-terminal, foreign, missing, and malformed tasks without writing', async () => {
      expect((await post(runningId, 'archive')).status).toBe(409);
      expect((await post(foreignId, 'archive')).status).toBe(409);
      expect((await post(randomUUID(), 'archive')).status).toBe(409);
      expect((await store.doc('tasks', runningId).get()).get('archivedAt')).toBeNull();
      expect((await store.doc('tasks', foreignId).get()).get('archivedAt')).toBeNull();
      await store.doc('tasks', doneId).update({ archivedAt: 'malformed' });
      expect((await post(doneId, 'archive')).status).toBe(409);
      expect((await store.doc('tasks', doneId).get()).get('archivedAt')).toBe('malformed');
    });

    it('requires auth and denies every other Firestore Activity mutation', async () => {
      auth.allowed.mockResolvedValueOnce(false);
      expect((await post(doneId, 'archive')).status).toBe(401);
      for (const action of ['retry', 'cancel', 'revoke-autonomy', 'raise-budget', 'archive-old'])
        expect((await post(doneId, action)).status).toBe(503);
      expect((await store.doc('tasks', doneId).get()).get('archivedAt')).toBeNull();
    });

    it('fails closed for active erasure or ambiguous configured ownership', async () => {
      await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
      try {
        expect((await post(doneId, 'archive')).status).toBe(409);
      } finally {
        await store.doc('privacyErasureJobs', agentId).delete();
      }
      await store.doc('agents', foreignAgentId).set({ id: foreignAgentId });
      try {
        expect((await post(doneId, 'archive')).status).toBe(409);
      } finally {
        await store.doc('agents', foreignAgentId).delete();
      }
      expect((await store.doc('tasks', doneId).get()).get('archivedAt')).toBeNull();
    });
  },
);
