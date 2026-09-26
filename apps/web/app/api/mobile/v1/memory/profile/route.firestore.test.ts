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
    const databaseId = 'assistant-voice-profile-test';
    const store = createInstallationStore({
      projectId: 'demo-assistant-test',
      installationId,
      databaseId,
    });
    let route: typeof import('./route.js');

    beforeAll(async () => {
      vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
      vi.stubEnv('DATABASE_URL', 'postgres://offline:offline@127.0.0.1:1/offline_test');
      vi.stubEnv('GCP_PROJECT', 'demo-assistant-test');
      vi.stubEnv('ASSISTANT_WORKSPACE_ID', installationId);
      vi.stubEnv('FIRESTORE_DATABASE_ID', databaseId);
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

    const post = (body: unknown) =>
      route.POST(
        new Request('http://localhost/api/mobile/v1/memory/profile', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );

    it('allows profile reads and edits through the proxy', async () => {
      const { proxy } = await import('../../../../../../proxy.js');
      expect(
        proxy(new NextRequest('http://localhost/api/mobile/v1/memory/profile', { method: 'GET' }))
          .status,
      ).toBe(200);
      expect(
        proxy(new NextRequest('http://localhost/api/mobile/v1/memory/profile', { method: 'POST' }))
          .status,
      ).toBe(200);
    });

    it('saves bounded voice edits from mobile arrays without PostgreSQL', async () => {
      auth.allowed.mockResolvedValue(true);
      const response = await post({
        action: 'voice-profile',
        description: '  Direct and warm  ',
        dos: ['Lead with result', 'Name a tradeoff'],
        donts: ['Hedge'],
        signature: '  B  ',
      });
      expect(response.status).toBe(200);
      expect((await store.doc('voiceProfile', '1').get()).data()).toMatchObject({
        id: 1,
        description: 'Direct and warm',
        dos: ['Lead with result', 'Name a tradeoff'],
        donts: ['Hedge'],
        signature: 'B',
      });
      const invalid = await post({ action: 'voice-profile', description: '   ' });
      expect(invalid.status).toBe(400);
      expect((await store.doc('voiceProfile', '1').get()).get('description')).toBe(
        'Direct and warm',
      );
    });

    it('recompiles the configured owner card with PostgreSQL offline', async () => {
      auth.allowed.mockResolvedValue(true);
      const ownerContactId = randomUUID();
      const memoryId = randomUUID();
      await store.doc('contacts', ownerContactId).set({
        id: ownerContactId,
        name: 'Owner',
        trust: 'owner',
        relationship: '',
      });
      await store.doc('memories', memoryId).set({
        id: memoryId,
        agentId,
        subjectContactId: ownerContactId,
        category: 'knowledge',
        content: 'Owner-requested profile fact',
        contentHash: `hash-${memoryId}`,
        confidence: '0.90',
        importance: 5,
        domain: 'work',
        pinned: true,
        quarantined: false,
        supersededById: null,
        expiresAt: null,
        validFrom: null,
        validUntil: null,
      });

      const response = await post({ action: 'recompile' });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect((await store.doc('ownerCards', agentId).get()).get('content')).toContain(
        'Owner-requested profile fact',
      );
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
        store.doc('writingSamples', autoId).set({ id: autoId, agentId, context: 'auto:mail' }),
        store
          .doc('writingSamples', uploadId)
          .set({ id: uploadId, agentId, context: 'upload:takeout' }),
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
      expect((await post({ action: 'voice-profile', description: 'Blocked' })).status).toBe(409);
      await store.doc('privacyErasureJobs', agentId).delete();
      const extra = randomUUID();
      await store.doc('agents', extra).set({ id: extra });
      try {
        await expect(get()).rejects.toThrow('one matching configured owner');
        expect((await post({ action: 'voice-profile', description: 'Blocked' })).status).toBe(409);
      } finally {
        await store.doc('agents', extra).delete();
      }
    });

    it('purges imported and uploaded voice samples and stops running voice imports', async () => {
      auth.allowed.mockResolvedValue(true);
      const sample = (context: string) => {
        const id = randomUUID();
        return store.doc('writingSamples', id).set({ id, agentId, context, text: context });
      };
      // Start from a known corpus; earlier cases seed samples of their own.
      const earlier = await store.collection('writingSamples').get();
      await Promise.all(earlier.docs.map((doc) => doc.ref.delete()));
      await Promise.all([
        sample('auto:mail'),
        sample('auto:sent'),
        sample('upload:takeout'),
        sample('owner:typed'),
      ]);
      const runningTask = randomUUID();
      const finishedTask = randomUUID();
      await store.doc('tasks', runningTask).set({ id: runningTask, agentId, status: 'running' });
      await store.doc('tasks', finishedTask).set({ id: finishedTask, agentId, status: 'done' });
      const voiceSource = randomUUID();
      const otherSource = randomUUID();
      await store.doc('importSources', voiceSource).set({
        id: voiceSource,
        agentId,
        source: 'voice-samples:takeout',
        taskId: runningTask,
        workspacePath: 'imports/voice-takeout.mbox',
      });
      await store.doc('importSources', otherSource).set({
        id: otherSource,
        agentId,
        source: 'chatgpt:export',
        taskId: finishedTask,
        workspacePath: 'imports/chatgpt.zip',
      });

      const response = await post({ action: 'purge-voice' });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, deleted: 3 });
      const left = await store.collection('writingSamples').where('agentId', '==', agentId).get();
      expect(left.docs.map((doc) => doc.get('context'))).toEqual(['owner:typed']);
      expect((await store.doc('tasks', runningTask).get()).get('status')).toBe('cancelled');
      expect((await store.doc('tasks', finishedTask).get()).get('status')).toBe('done');
      expect((await store.doc('importSources', voiceSource).get()).exists).toBe(false);
      expect((await store.doc('importSources', otherSource).get()).exists).toBe(true);
    });
  },
);
