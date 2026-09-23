import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore } from '@assistant/firestore';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ allowed: vi.fn() }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: auth.allowed,
  mobileJson: (value: unknown, init?: ResponseInit) => Response.json(value, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'mobile packs in Firestore mode with PostgreSQL offline',
  () => {
    const installationId = `mobile-packs-${randomUUID()}`;
    const agentId = randomUUID();
    const packId = randomUUID();
    const store = createInstallationStore({
      projectId: 'demo-assistant-test',
      installationId,
      databaseId: '(default)',
    });
    let route: typeof import('./route.js');

    beforeAll(async () => {
      vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
      vi.stubEnv('DATABASE_URL', 'postgres://offline:offline@127.0.0.1:1/offline_test');
      vi.stubEnv('GCP_PROJECT', 'demo-assistant-test');
      vi.stubEnv('ASSISTANT_WORKSPACE_ID', installationId);
      vi.stubEnv('FIRESTORE_DATABASE_ID', '(default)');
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
      await store.doc('agents', agentId).set({ id: agentId });
      await store.doc('situationPacks', packId).set({
        id: packId,
        agentId,
        creationKey: 'test',
        title: 'Owner plan',
        createdAt: new Date(),
        updatedAt: new Date(),
        version: 1,
        archived: false,
        data: { items: [], decisions: [] },
      });
      route = await import('./route.js');
    });

    afterAll(async () => {
      const { getFirestoreInstallationStore } = await import('@/lib/server');
      const cached = getFirestoreInstallationStore();
      await cached.db.recursiveDelete(cached.root);
      await cached.db.terminate();
      await store.db.terminate();
      vi.unstubAllEnvs();
      resetConfigForTest();
    });

    it('reads and writes packs while PostgreSQL is offline', async () => {
      const request = new Request('http://localhost/api/mobile/v1/packs');
      const response = await route.GET(request);
      expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
      expect((await response.json()).packs).toMatchObject([{ id: packId, title: 'Owner plan' }]);
      const post = await route.POST(
        new Request(request.url, {
          method: 'POST',
          body: JSON.stringify({
            action: 'item',
            packId,
            version: 1,
            item: { id: 'flight', title: 'Confirm flight', dependsOn: [], source: null },
          }),
        }),
      );
      expect(post.status).toBe(200);
      expect(await post.json()).toMatchObject({ ok: true, packId });
      expect((await store.doc('situationPacks', packId).get()).data()).toMatchObject({
        version: 2,
        data: { items: [{ id: 'flight', title: 'Confirm flight' }] },
      });
      expect((await store.collection('situationPacks').get()).size).toBe(1);
    });

    it('requires mobile authentication before reading', async () => {
      auth.allowed.mockResolvedValueOnce(false);
      expect((await route.GET(new Request('http://localhost/api/mobile/v1/packs'))).status).toBe(
        401,
      );
    });
  },
);
