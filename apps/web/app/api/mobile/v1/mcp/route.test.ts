import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import {
  createInstallationStore,
  FirestoreMcpConnectionReadRepository,
} from '@assistant/firestore';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ allowed: vi.fn() }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: auth.allowed,
  mobileJson: (value: unknown, init?: ResponseInit) =>
    Response.json(value, { ...init, headers: { 'cache-control': 'no-store' } }),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)(
  'Firestore mobile MCP connection summaries with PostgreSQL offline',
  () => {
    const installationId = `mobile-mcp-read-${randomUUID()}`;
    const agentId = randomUUID();
    const foreignAgentId = randomUUID();
    const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
    let route: typeof import('./route.js');

    const connection = (id: string, name: string, patch: Record<string, unknown> = {}) => ({
      id,
      agentId,
      name,
      createdAt: new Date('2026-09-20T12:00:00Z'),
      updatedAt: new Date('2026-09-20T12:00:00Z'),
      status: 'ready',
      endpoint: `https://${name}.example.test/mcp`,
      bearerTokenEncrypted: null,
      enabled: true,
      serverName: `${name} server`,
      serverVersion: '1.0',
      instructions: null,
      tools: [{ name: 'search' }],
      lastCheckedAt: new Date('2026-09-21T12:00:00Z'),
      lastError: null,
      ...patch,
    });

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
      auth.allowed.mockResolvedValue(true);
      route = await import('./route.js');
      const alphaId = randomUUID();
      const betaId = randomUUID();
      const zuluId = randomUUID();
      const foreignId = randomUUID();
      await Promise.all([
        store.doc('agents', agentId).set({ id: agentId }),
        store
          .doc('mcpConnections', alphaId)
          .set(connection(alphaId, 'alpha', { bearerTokenEncrypted: 'ciphertext-secret' })),
        store
          .doc('mcpConnections', betaId)
          .set(connection(betaId, 'beta', { enabled: false, status: 'ready' })),
        store.doc('mcpConnections', zuluId).set(connection(zuluId, 'zulu')),
        store
          .doc('mcpConnections', foreignId)
          .set(connection(foreignId, 'foreign', { agentId: foreignAgentId })),
      ]);
    });

    afterAll(async () => {
      await store.db.recursiveDelete(store.root);
      await store.db.terminate();
      vi.unstubAllEnvs();
      resetConfigForTest();
    });

    it('allows only authenticated list GET through the Firestore proxy', async () => {
      const { proxy } = await import('../../../../../proxy.js');
      expect(proxy(new NextRequest('http://localhost/api/mobile/v1/mcp')).status).toBe(200);
      expect(
        proxy(new NextRequest('http://localhost/api/mobile/v1/mcp', { method: 'POST' })).status,
      ).toBe(503);
      auth.allowed.mockResolvedValue(false);
      expect((await route.GET(new Request('http://localhost/api/mobile/v1/mcp'))).status).toBe(401);
    });

    it('returns sorted owner summaries and only reports encrypted credential presence', async () => {
      auth.allowed.mockResolvedValue(true);
      const response = await route.GET(new Request('http://localhost/api/mobile/v1/mcp'));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.connections.map((row: { name: string }) => row.name)).toEqual([
        'alpha',
        'beta',
        'zulu',
      ]);
      expect(body.connections[0]).toMatchObject({
        name: 'alpha',
        hasBearerToken: true,
        status: 'ready',
        tools: [{ name: 'search' }],
      });
      expect(JSON.stringify(body)).not.toContain('ciphertext-secret');
      expect(body.connections[1]).toMatchObject({
        name: 'beta',
        enabled: false,
        status: 'disabled',
      });
      expect(body.connections.map((row: { name: string }) => row.name)).not.toContain('foreign');
      expect(
        body.connections.every((row: Record<string, unknown>) => !('bearerTokenEncrypted' in row)),
      ).toBe(true);
    });

    it('fails closed while a privacy erasure is active', async () => {
      await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
      await expect(
        new FirestoreMcpConnectionReadRepository(store, agentId).list(agentId),
      ).rejects.toThrow('Privacy erasure is in progress');
      await store.doc('privacyErasureJobs', agentId).delete();
    });
  },
);
