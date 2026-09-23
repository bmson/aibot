import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore } from '@assistant/firestore';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ allowed: vi.fn() }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: auth.allowed,
  mobileJson: (value: unknown, init?: ResponseInit) => Response.json(value, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)(
  'Firestore mobile memory profile read with PostgreSQL offline',
  () => {
    const installationId = `mobile-memory-profile-${randomUUID()}`;
    const agentId = randomUUID();
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
      await store.doc('agents', agentId).set({ id: agentId });
    });

    afterAll(async () => {
      await store.db.recursiveDelete(store.root);
      await store.db.terminate();
      vi.unstubAllEnvs();
      resetConfigForTest();
    });

    const get = () => route.GET(new Request('http://localhost/api/mobile/v1/memory/profile'));

    it('allows only GET through the Firestore proxy and denies POST in the route', async () => {
      const { proxy } = await import('../../../../../../proxy.js');
      expect(
        proxy(new NextRequest('http://localhost/api/mobile/v1/memory/profile', { method: 'GET' }))
          .status,
      ).toBe(200);
      expect(
        proxy(new NextRequest('http://localhost/api/mobile/v1/memory/profile', { method: 'POST' }))
          .status,
      ).toBe(503);
      auth.allowed.mockResolvedValue(true);
      const response = await route.POST(
        new Request('http://localhost/api/mobile/v1/memory/profile', {
          method: 'POST',
          body: JSON.stringify({ action: 'forget-all', confirm: 'forget-all' }),
        }),
      );
      expect(response.status).toBe(503);
    });

    it('requires mobile authentication before reading', async () => {
      auth.allowed.mockResolvedValue(false);
      expect((await get()).status).toBe(401);
    });

    it('returns the existing two-field contract from the configured owner without PostgreSQL', async () => {
      auth.allowed.mockResolvedValue(true);
      const autoId = randomUUID();
      const uploadId = randomUUID();
      await Promise.all([
        store.doc('writingSamples', autoId).set({ id: autoId, context: 'auto:mail' }),
        store.doc('writingSamples', uploadId).set({ id: uploadId, context: 'upload:takeout' }),
        store.doc('voiceProfile', '1').set({
          id: 1,
          description: 'Direct',
          dos: ['Lead with result'],
          donts: ['hedge'],
          signature: 'B',
        }),
      ]);
      const response = await get();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        voiceStats: { total: 2, auto: 1, uploaded: 1 },
        voiceProfile: {
          description: 'Direct',
          dos: ['Lead with result'],
          donts: ['hedge'],
          signature: 'B',
        },
      });
    });

    it('fails closed on active erasure and ambiguous configured agents', async () => {
      auth.allowed.mockResolvedValue(true);
      await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
      await expect(get()).rejects.toThrow('Privacy erasure');
      await store.doc('privacyErasureJobs', agentId).delete();
      const extra = randomUUID();
      await store.doc('agents', extra).set({ id: extra });
      try {
        await expect(get()).rejects.toThrow('one matching configured owner');
      } finally {
        await store.doc('agents', extra).delete();
      }
    });
  },
);
