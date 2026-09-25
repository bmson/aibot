import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore } from '@assistant/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ mobile: vi.fn() }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: auth.mobile,
  mobileJson: (body: unknown, init?: ResponseInit) => Response.json(body, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), unstable_cache: (run: unknown) => run }));

import { getDb } from '@/lib/server';
import { POST } from './route';

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)(
  'Firestore mobile memory maintenance with PostgreSQL offline',
  () => {
    const installationId = `mobile-memory-maintenance-${randomUUID()}`;
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

    const post = (body: unknown) =>
      POST(
        new Request('http://localhost/api/mobile/v1/memory/profile', {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      );

    it('queues one memory organization pass and reports the queued one on repeat', async () => {
      expect(() => getDb()).toThrow('PostgreSQL-backed web surface is unavailable');
      const first = await post({ action: 'organize' });
      expect(first.status).toBe(200);
      const queued = (await first.json()) as { outcome: string; taskId: string };
      expect(queued.outcome).toBe('queued');
      const task = await store.doc('tasks', queued.taskId).get();
      expect(task.get('agentId')).toBe(agentId);
      expect(task.get('trigger')).toMatchObject({ payload: { job: 'memory.consolidate' } });

      const repeat = (await (await post({ action: 'organize' })).json()) as {
        outcome: string;
        taskId: string;
      };
      expect(repeat).toMatchObject({ outcome: 'already-running', taskId: queued.taskId });
    });

    it('erases long-term memory only with the explicit confirmation', async () => {
      await store.doc('memories', 'owner-memory').set({
        id: 'owner-memory',
        agentId,
        contentHash: `hash-${agentId}`,
        content: 'Private fact',
      });
      expect((await post({ action: 'forget-all' })).status).toBe(400);
      expect((await store.doc('memories', 'owner-memory').get()).exists).toBe(true);

      const erased = await post({ action: 'forget-all', confirm: 'forget-all' });
      expect(erased.status).toBe(200);
      expect((await store.doc('memories', 'owner-memory').get()).exists).toBe(false);
    });
  },
);
