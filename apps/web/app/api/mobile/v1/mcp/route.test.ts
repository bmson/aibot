import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import {
  createInstallationStore,
  FirestoreMcpConnectionMutationRepository,
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
    const databaseId = `mobile-mcp-${randomUUID()}`;
    const installationId = `mobile-mcp-read-${randomUUID()}`;
    const agentId = randomUUID();
    const foreignAgentId = randomUUID();
    const foreignId = randomUUID();
    const store = createInstallationStore({
      projectId: 'demo-assistant-test',
      installationId,
      databaseId,
    });
    let route: typeof import('./route.js');
    let itemRoute: typeof import('./[id]/route.js');

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
      vi.stubEnv('FIRESTORE_DATABASE_ID', databaseId);
      vi.stubEnv('MCP_ENC_KEY', '11'.repeat(32));
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
      itemRoute = await import('./[id]/route.js');
      const alphaId = randomUUID();
      const betaId = randomUUID();
      const zuluId = randomUUID();
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
      ).toBe(200);
      expect(
        proxy(
          new NextRequest(`http://localhost/api/mobile/v1/mcp/${randomUUID()}`, {
            method: 'DELETE',
          }),
        ).status,
      ).toBe(200);
      expect(
        proxy(new NextRequest('http://localhost/api/mobile/v1/mcp/not-a-uuid', { method: 'POST' }))
          .status,
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

    it('creates an encrypted owner connection and supports enable, disable, and delete offline', async () => {
      auth.allowed.mockResolvedValue(true);
      const createdResponse = await route.POST(
        new Request('http://localhost/api/mobile/v1/mcp', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: ' New   Service ',
            endpoint: 'https://service.example.test/mcp#ignored',
            bearerToken: 'owner-secret-token',
          }),
        }),
      );
      expect(createdResponse.status).toBe(201);
      const created = await createdResponse.json();
      expect(created).toMatchObject({
        status: 'error',
        error: 'MCP discovery is unavailable in Firestore mode.',
      });
      const stored = await store.doc('mcpConnections', created.connectionId).get();
      expect(stored.get('name')).toBe('New Service');
      expect(stored.get('endpoint')).toBe('https://service.example.test/mcp');
      expect(stored.get('bearerTokenEncrypted')).not.toBe('owner-secret-token');
      expect(stored.get('bearerTokenEncrypted')).toMatch(/^v2\./);

      const postAction = (action: string) =>
        itemRoute.POST(
          new Request(`http://localhost/api/mobile/v1/mcp/${created.connectionId}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action }),
          }),
          { params: Promise.resolve({ id: created.connectionId }) },
        );
      const disabled = await postAction('disable');
      expect(await disabled.json()).toMatchObject({ status: 'disabled' });
      const enabled = await postAction('enable');
      expect(await enabled.json()).toMatchObject({
        status: 'error',
        error: 'MCP discovery is unavailable in Firestore mode.',
      });
      expect((await postAction('refresh')).status).toBe(503);
      expect((await store.doc('mcpConnections', created.connectionId).get()).get('enabled')).toBe(
        true,
      );
      const deleted = await itemRoute.DELETE(
        new Request(`http://localhost/api/mobile/v1/mcp/${created.connectionId}`, {
          method: 'DELETE',
        }),
        { params: Promise.resolve({ id: created.connectionId }) },
      );
      expect(await deleted.json()).toEqual({ ok: true });
      expect((await store.doc('mcpConnections', created.connectionId).get()).exists).toBe(false);
    });

    it('fences create and mutations during erasure and refuses foreign connection ids', async () => {
      const repository = new FirestoreMcpConnectionMutationRepository(store, agentId);
      await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
      await expect(
        repository.create({
          name: 'blocked',
          endpoint: 'https://blocked.example/mcp',
          bearerTokenEncrypted: null,
        }),
      ).resolves.toMatchObject({ error: 'Privacy erasure is in progress' });
      await store.doc('privacyErasureJobs', agentId).delete();
      expect(await repository.setEnabled(foreignId, false)).toBeNull();
      expect(await repository.delete(foreignId)).toBe(false);
    });
  },
);
