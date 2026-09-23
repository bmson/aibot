import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore } from '@assistant/firestore';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ mobile: vi.fn() }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: auth.mobile,
  mobileJson: (body: unknown, init?: ResponseInit) =>
    Response.json(body, { ...init, headers: { 'cache-control': 'no-store' } }),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));

const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(
  process.env.FIRESTORE_EMULATOR_HOST ?? '',
);

describe.skipIf(!localEmulator)('Firestore mobile commitments with PostgreSQL offline', () => {
  const installationId = `mobile-commitments-${randomUUID()}`;
  const foreignInstallationId = `foreign-commitments-${randomUUID()}`;
  const agentId = randomUUID();
  const otherAgentId = randomUUID();
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
  const foreignStore = createInstallationStore({
    projectId: 'demo-assistant-test',
    installationId: foreignInstallationId,
  });
  const url = 'http://localhost/api/mobile/v1/memory/commitments';
  const now = new Date();
  const dueAt = new Date(now.getTime() + 3_600_000);

  const row = (id: string, fields: Record<string, unknown> = {}) => ({
    id,
    agentId,
    conversationId: randomUUID(),
    sourceMessageId: null,
    sourceTaskId: null,
    kind: 'promise',
    title: `Commitment ${id}`,
    details: 'Details',
    nextAction: 'Call back',
    status: 'open',
    dueAt,
    snoozedUntil: null,
    resolvedAt: null,
    resolution: null,
    confidence: '0.90',
    contentHash: id,
    createdAt: now,
    updatedAt: now,
    ...fields,
  });

  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://offline:offline@127.0.0.1:1/offline_test');
    vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
    vi.stubEnv('GCP_PROJECT', 'demo-assistant-test');
    vi.stubEnv('ASSISTANT_WORKSPACE_ID', installationId);
    vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
    vi.stubEnv(
      'FIRESTORE_EMBEDDING_SPACE',
      '{"provider":"vertex","model":"example-embedding","dimensions":768,"revision":"fixture-v1"}',
    );
    vi.stubEnv('LLM_PROVIDER', 'vertex');
    vi.stubEnv('ASSISTANT_MODULES', 'minimal');
    vi.stubEnv('QUEUE_DRIVER', 'local');
    vi.stubEnv('CANARY_ENABLED', 'false');
    vi.stubEnv('LOCATION_PING_SECRET', '');
    resetConfigForTest();
    auth.mobile.mockResolvedValue(true);
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId }),
      store
        .doc('commitments', 'open-later')
        .set(row('open-later', { updatedAt: new Date(now.getTime() - 1000) })),
      store.doc('commitments', 'elapsed-snooze').set(
        row('elapsed-snooze', {
          status: 'snoozed',
          snoozedUntil: new Date(now.getTime() - 3_600_000),
          updatedAt: new Date(now.getTime() + 1000),
        }),
      ),
      store.doc('commitments', 'future-snooze').set(
        row('future-snooze', {
          status: 'snoozed',
          snoozedUntil: new Date(now.getTime() + 3_600_000),
        }),
      ),
      store.doc('commitments', 'resolved').set(row('resolved', { status: 'resolved' })),
      store.doc('commitments', 'other-agent').set(row('other-agent', { agentId: otherAgentId })),
      foreignStore.doc('agents', otherAgentId).set({ id: otherAgentId }),
      foreignStore.doc('commitments', 'foreign-installation').set(row('foreign-installation')),
    ]);
  });

  afterAll(async () => {
    await Promise.all([
      store.db.recursiveDelete(store.root),
      foreignStore.db.recursiveDelete(foreignStore.root),
    ]);
    await Promise.all([store.db.terminate(), foreignStore.db.terminate()]);
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  it('allows exact GET only through the Firestore proxy', async () => {
    const { proxy } = await import('../../../../../../proxy.js');
    const status = (path: string, method = 'GET') =>
      proxy(new NextRequest(`http://localhost${path}`, { method })).status;
    expect(status('/api/mobile/v1/memory/commitments')).toBe(200);
    expect(status('/api/mobile/v1/memory/commitments', 'POST')).toBe(503);
    expect(status('/api/mobile/v1/memory/commitments/other')).toBe(503);
    const { POST } = await import('./route.js');
    expect(
      (
        await POST(
          new Request(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'resolve', id: 'open-later' }),
          }),
        )
      ).status,
    ).toBe(503);
  });

  it('preserves the exact JSON contract and active ranking without PostgreSQL', async () => {
    const { GET } = await import('./route.js');
    const { getDb } = await import('@/lib/server');
    expect(() => getDb()).toThrow('PostgreSQL-backed web surface is unavailable');
    const response = await GET(new Request(url));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(Object.keys(body)).toEqual(['commitments']);
    expect(body.commitments.map((item: { id: string }) => item.id)).toEqual([
      'elapsed-snooze',
      'open-later',
    ]);
    expect(body.commitments[0]).toEqual({
      id: 'elapsed-snooze',
      kind: 'promise',
      title: 'Commitment elapsed-snooze',
      details: 'Details',
      nextAction: 'Call back',
      dueAt: dueAt.toISOString(),
      status: 'snoozed',
    });
    expect(JSON.stringify(body)).not.toContain('foreign-installation');
  });

  it('authenticates first and fails closed for erasure, owner mismatch, and malformed rows', async () => {
    const { GET } = await import('./route.js');
    auth.mobile.mockResolvedValueOnce(false);
    expect((await GET(new Request(url))).status).toBe(401);
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    try {
      await expect(GET(new Request(url))).rejects.toThrow('Privacy erasure is in progress');
    } finally {
      await store.doc('privacyErasureJobs', agentId).delete();
    }
    vi.stubEnv('FIRESTORE_AGENT_ID', otherAgentId);
    resetConfigForTest();
    try {
      await expect(GET(new Request(url))).rejects.toThrow('exactly one configured agent');
    } finally {
      vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
      resetConfigForTest();
    }
    await store.doc('agents', otherAgentId).set({ id: otherAgentId });
    try {
      await expect(GET(new Request(url))).rejects.toThrow('exactly one configured agent');
    } finally {
      await store.doc('agents', otherAgentId).delete();
    }
    const ref = store.doc('commitments', 'open-later');
    await ref.update({ dueAt: 'invalid' });
    try {
      await expect(GET(new Request(url))).rejects.toThrow('malformed active row');
    } finally {
      await ref.update({ dueAt });
    }
  });

  it('applies the same 30-row overview limit and preserves a null due date', async () => {
    const { GET } = await import('./route.js');
    const ids = Array.from({ length: 31 }, (_, index) => `extra-${index}`);
    await Promise.all(
      ids.map((id, index) =>
        store.doc('commitments', id).set(
          row(id, {
            dueAt: index === 30 ? null : dueAt,
            updatedAt: new Date(now.getTime() + 10_000 + index),
          }),
        ),
      ),
    );
    try {
      const response = await GET(new Request(url));
      const body = await response.json();
      expect(body.commitments).toHaveLength(30);
      expect(body.commitments[0]).toMatchObject({ id: 'extra-30', dueAt: null });
    } finally {
      await Promise.all(ids.map((id) => store.doc('commitments', id).delete()));
    }
  });
});
