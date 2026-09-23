import { randomUUID } from 'node:crypto';
import { createInstallationStore } from '@assistant/firestore';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ mobile: vi.fn() }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: auth.mobile,
  mobileJson: (body: unknown, init?: ResponseInit) => Response.json(body, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)(
  'Firestore mobile improvement actions with PostgreSQL offline',
  () => {
    const installationId = `mobile-improvements-${randomUUID()}`;
    const agentId = randomUUID();
    const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
    const base = 'http://localhost/api/mobile/v1/improvements';
    let post: typeof import('../app/api/mobile/v1/improvements/[id]/route.js').POST;

    beforeAll(async () => {
      vi.stubEnv('DATABASE_URL', 'postgres://offline:offline@127.0.0.1:1/offline_test');
      vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
      vi.stubEnv('ASSISTANT_MODULES', 'minimal');
      vi.stubEnv('ASSISTANT_WORKSPACE_ID', installationId);
      vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
      vi.stubEnv(
        'FIRESTORE_EMBEDDING_SPACE',
        '{"provider":"openai","model":"text-embedding-3-small","dimensions":1536,"revision":"1"}',
      );
      vi.stubEnv('GCP_PROJECT', 'demo-assistant-test');
      vi.stubEnv('QUEUE_DRIVER', 'local');
      auth.mobile.mockResolvedValue(true);
      ({ POST: post } = await import('../app/api/mobile/v1/improvements/[id]/route.js'));
      await store.doc('agents', agentId).set({ id: agentId, name: 'Assistant' });
    });

    afterAll(async () => {
      await store.db.recursiveDelete(store.root);
      await store.db.terminate();
      vi.unstubAllEnvs();
    });

    async function seed(kind: string, taskAgentId = agentId) {
      const id = randomUUID();
      await store.doc('improvementProposals', id).set({
        id,
        agentId: taskAgentId,
        status: 'open',
        kind,
        title: 'Suggested change',
        rationale: 'A tested suggestion',
        change: { suggestion: 'Change the setting' },
        evidenceIds: ['task-one'],
        createdAt: new Date(),
      });
      return id;
    }

    async function decide(id: string, action: string) {
      return post(
        new Request(`${base}/${id}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action }),
        }),
        { params: Promise.resolve({ id }) },
      );
    }

    it('acknowledges advisory actions and dismisses atomically while SQL is unavailable', async () => {
      const { proxy } = await import('../proxy.js');
      const { NextRequest } = await import('next/server');
      expect(
        proxy(
          new NextRequest(`http://localhost/api/mobile/v1/improvements/${randomUUID()}`, {
            method: 'POST',
          }),
        ).status,
      ).toBe(200);
      expect(
        proxy(new NextRequest(`http://localhost/api/mobile/v1/improvements/${randomUUID()}`))
          .status,
      ).toBe(503);
      expect(
        proxy(
          new NextRequest('http://localhost/api/mobile/v1/improvements/not-a-uuid', {
            method: 'POST',
          }),
        ).status,
      ).toBe(503);
      const { getDb } = await import('./server.js');
      expect(() => getDb()).toThrow('PostgreSQL-backed web surface is unavailable');

      const advisoryId = await seed('note');
      expect((await decide(advisoryId, 'apply')).status).toBe(200);
      expect((await store.doc('improvementProposals', advisoryId).get()).get('status')).toBe(
        'applied',
      );

      const dismissId = await seed('prompt');
      expect((await decide(dismissId, 'dismiss')).status).toBe(200);
      expect((await decide(dismissId, 'dismiss')).status).toBe(200);
      expect((await store.doc('improvementProposals', dismissId).get()).get('status')).toBe(
        'dismissed',
      );
    });

    it('fails closed for model routing changes, foreign proposals, and active erasure', async () => {
      const routingId = await seed('model_role');
      expect((await decide(routingId, 'apply')).status).toBe(409);
      expect((await store.doc('improvementProposals', routingId).get()).get('status')).toBe('open');

      const foreignId = await seed('note', randomUUID());
      expect((await decide(foreignId, 'dismiss')).status).toBe(409);
      expect((await store.doc('improvementProposals', foreignId).get()).get('status')).toBe('open');

      const erasureId = await seed('note');
      await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
      expect((await decide(erasureId, 'dismiss')).status).toBe(409);
      expect((await store.doc('improvementProposals', erasureId).get()).get('status')).toBe('open');
      await store.doc('privacyErasureJobs', agentId).delete();
    });
  },
);
