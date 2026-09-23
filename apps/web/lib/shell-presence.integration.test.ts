import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import {
  createInstallationStore,
  type FirestoreShellPresenceRepository,
} from '@assistant/firestore';
import { taskFixture } from '@assistant/persistence/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ web: vi.fn(), db: vi.fn() }));
vi.mock('@/auth', () => ({ isAuthed: auth.web }));
vi.mock('@/lib/server', () => ({
  getAgentIdentity: vi.fn(),
  getDb: auth.db,
}));

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)(
  'Firestore shell presence web route with PostgreSQL offline',
  () => {
    const installationId = `shell-presence-${randomUUID()}`;
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const seedStore = createInstallationStore({
      projectId: 'demo-assistant-test',
      installationId,
    });
    let route: typeof import('../app/api/shell/status/route.js');

    beforeAll(async () => {
      resetConfigForTest();
      vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
      vi.stubEnv('DATABASE_URL', 'postgres://assistant:assistant@127.0.0.1:1/offline_test');
      vi.stubEnv('GCP_PROJECT', 'demo-assistant-test');
      vi.stubEnv('ASSISTANT_WORKSPACE_ID', installationId);
      vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
      vi.stubEnv(
        'FIRESTORE_EMBEDDING_SPACE',
        '{"provider":"openai","model":"text-embedding-3-small","dimensions":1536,"revision":"1"}',
      );
      vi.stubEnv('ASSISTANT_MODULES', 'minimal');
      vi.stubEnv('QUEUE_DRIVER', 'local');
      vi.stubEnv('CANARY_ENABLED', 'false');
      vi.stubEnv('LOCATION_PING_SECRET', '');
      auth.web.mockResolvedValue({ user: { email: 'owner@example.com' } });
      auth.db.mockImplementation(() => {
        throw new Error('PostgreSQL is unreachable');
      });
      const server = await import('../app/api/shell/status/route.js');
      route = server;
      const { getAgentIdentity } = await import('./server.js');
      vi.mocked(getAgentIdentity).mockResolvedValue({
        id: agentId,
        name: 'Assistant',
        avatarUrl: null,
      });

      const ownerRunning = taskFixture({
        id: 'owner-running',
        agentId,
        conversationId: randomUUID(),
        reminderId: '',
      });
      ownerRunning.status = 'running';
      await seedStore.doc('tasks', ownerRunning.id).set(ownerRunning);
      const foreignAttention = taskFixture({
        id: 'foreign-attention',
        agentId: otherAgentId,
        conversationId: randomUUID(),
        reminderId: '',
      });
      foreignAttention.status = 'needs_attention';
      await seedStore.doc('tasks', foreignAttention.id).set(foreignAttention);
      await seedStore.doc('approvals', 'foreign-approval').set({
        id: 'foreign-approval',
        taskId: foreignAttention.id,
        status: 'pending',
        expiresAt: new Date(Date.now() + 60_000),
      });
    });

    afterAll(async () => {
      await seedStore.db.recursiveDelete(seedStore.root);
      const runtime = globalThis as typeof globalThis & {
        __assistantFirestoreShellPresence?: FirestoreShellPresenceRepository;
      };
      await runtime.__assistantFirestoreShellPresence?.store.db.terminate();
      delete runtime.__assistantFirestoreShellPresence;
      await seedStore.db.terminate();
      vi.unstubAllEnvs();
      resetConfigForTest();
    });

    it('returns owner presence through the authenticated route without opening PostgreSQL', async () => {
      const response = await route.GET();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ presence: 'working' });
      expect(auth.db).not.toHaveBeenCalled();

      await seedStore.doc('tasks', 'owner-running').update({ status: 'needs_attention' });
      const attention = await route.GET();
      expect(await attention.json()).toEqual({ presence: 'attention' });

      await seedStore.doc('tasks', 'owner-running').update({ status: 'done' });
      const idle = await route.GET();
      expect(await idle.json()).toEqual({ presence: 'idle' });
    }, 20_000);
  },
);
