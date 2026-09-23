import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore } from '@assistant/firestore';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ owner: vi.fn(), getDb: vi.fn(), getStore: vi.fn() }));
vi.mock('@/auth', () => ({ requireOwner: mocks.owner }));
vi.mock('@/lib/server', () => ({
  getAgentIdentity: vi.fn(() => {
    throw new Error('PostgreSQL identity path reached');
  }),
  getDb: mocks.getDb,
  getFirestoreInstallationStore: mocks.getStore,
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { proxy } from '../../proxy.js';
import { changePack, loadPacks } from './actions.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'web packs in Firestore mode with PostgreSQL offline',
  () => {
    const installationId = `web-packs-${randomUUID()}`;
    const agentId = randomUUID();
    const packId = randomUUID();
    const store = createInstallationStore({
      projectId: 'demo-assistant-test',
      installationId,
      databaseId: '(default)',
    });

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
      mocks.owner.mockResolvedValue(undefined);
      mocks.getDb.mockImplementation(() => {
        throw new Error('PostgreSQL path reached');
      });
      mocks.getStore.mockReturnValue(store);
      await store.doc('agents', agentId).set({ id: agentId });
      await store.doc('situationPacks', packId).set({
        id: packId,
        agentId,
        creationKey: 'test',
        title: 'Web plan',
        createdAt: new Date(),
        updatedAt: new Date(),
        version: 1,
        archived: false,
        data: { items: [], decisions: [] },
      });
    });

    afterAll(async () => {
      await store.db.recursiveDelete(store.root);
      await store.db.terminate();
      vi.unstubAllEnvs();
      resetConfigForTest();
    });

    it('loads and writes owner packs while PostgreSQL is offline', async () => {
      for (const path of ['/packs', '/api/mobile/v1/packs']) {
        expect(proxy(new NextRequest(`http://localhost${path}`, { method: 'POST' })).status).toBe(
          200,
        );
        expect(proxy(new NextRequest(`http://localhost${path}`, { method: 'DELETE' })).status).toBe(
          503,
        );
      }
      expect((await loadPacks()).packs).toMatchObject([{ id: packId, title: 'Web plan' }]);
      expect(
        await changePack({
          action: 'item',
          packId,
          version: 1,
          item: { id: 'flight', title: 'Confirm flight', dependsOn: [], source: null },
        }),
      ).toMatchObject({ ok: true, packId });
      expect((await store.collection('situationPacks').get()).size).toBe(1);
      expect(mocks.getDb).not.toHaveBeenCalled();
      expect((await store.doc('situationPacks', packId).get()).get('version')).toBe(2);
    });
  },
);
