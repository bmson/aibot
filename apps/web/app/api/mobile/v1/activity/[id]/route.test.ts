import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore } from '@assistant/firestore';
import { taskFixture } from '@assistant/persistence/testing';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ allowed: vi.fn() }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: auth.allowed,
  mobileJson: (value: unknown, init?: ResponseInit) => Response.json(value, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)(
  'Firestore mobile Activity archive/restore with PostgreSQL offline',
  () => {
    const databaseId = `mobile-activity-${randomUUID()}`;
    const installationId = `mobile-activity-actions-${randomUUID()}`;
    const agentId = randomUUID();
    const foreignAgentId = randomUUID();
    const doneId = randomUUID();
    const runningId = randomUUID();
    const attentionId = randomUUID();
    const autonomyId = randomUUID();
    const retryId = randomUUID();
    const cancelId = randomUUID();
    const foreignId = randomUUID();
    const initial = new Date('2026-09-20T12:00:00Z');
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
    });

    beforeEach(async () => {
      auth.allowed.mockResolvedValue(true);
      await store.db.recursiveDelete(store.root);
      await Promise.all([
        store.doc('agents', agentId).set({ id: agentId }),
        store
          .doc('tasks', doneId)
          .set({ id: doneId, agentId, status: 'done', archivedAt: null, updatedAt: initial }),
        store
          .doc('tasks', runningId)
          .set({ id: runningId, agentId, status: 'running', archivedAt: null, updatedAt: initial }),
        store.doc('tasks', foreignId).set({
          id: foreignId,
          agentId: foreignAgentId,
          status: 'done',
          archivedAt: null,
          updatedAt: initial,
        }),
        store.doc('tasks', attentionId).set({
          ...taskFixture({
            id: attentionId,
            agentId,
            conversationId: randomUUID(),
            reminderId: '',
          }),
          status: 'needs_attention',
          budgetUsdLimit: '0.5000',
          spentUsd: '0.2500',
          queueGeneration: 4,
          state: { pendingFinal: { text: 'already delivered' }, checkpoint: 'continue here' },
        }),
        store.doc('tasks', autonomyId).set({
          ...taskFixture({ id: autonomyId, agentId, conversationId: randomUUID(), reminderId: '' }),
          autonomyGrant: { scope: 'task', grantedAt: initial.toISOString() },
        }),
        store.doc('tasks', retryId).set({
          ...taskFixture({ id: retryId, agentId, conversationId: randomUUID(), reminderId: '' }),
          status: 'needs_attention',
          queueGeneration: 2,
          attempt: 4,
          state: { checkpoint: 'continue here', pendingFinal: { text: 'already delivered' } },
        }),
        store.doc('tasks', cancelId).set({
          ...taskFixture({ id: cancelId, agentId, conversationId: randomUUID(), reminderId: '' }),
          status: 'running',
          lockedUntil: new Date(initial.getTime() + 60_000),
          leaseToken: randomUUID(),
          attempt: 3,
        }),
      ]);
    });

    afterAll(async () => {
      await store.db.recursiveDelete(store.root);
      await store.db.terminate();
      vi.unstubAllEnvs();
      resetConfigForTest();
    });

    const post = (id: string, action: string, extra: Record<string, unknown> = {}) =>
      route.POST(
        new Request(`http://localhost/api/mobile/v1/activity/${id}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, ...extra }),
        }),
        { params: Promise.resolve({ id }) },
      );

    it('allows only the scoped POST route through the proxy', async () => {
      const { proxy } = await import('../../../../../../proxy.js');
      expect(
        proxy(
          new NextRequest(`http://localhost/api/mobile/v1/activity/${doneId}`, { method: 'POST' }),
        ).status,
      ).toBe(200);
      expect(
        proxy(new NextRequest(`http://localhost/api/mobile/v1/activity/${doneId}`)).status,
      ).toBe(503);
      expect(
        proxy(new NextRequest('http://localhost/api/mobile/v1/activity', { method: 'POST' }))
          .status,
      ).toBe(200);
      expect(
        proxy(
          new NextRequest('http://localhost/api/mobile/v1/activity/not-a-uuid', { method: 'POST' }),
        ).status,
      ).toBe(503);
    });

    it('archives a terminal owner task and restores it atomically', async () => {
      expect((await post(doneId, 'archive')).status).toBe(200);
      const archived = await store.doc('tasks', doneId).get();
      const archivedAt = archived.get('archivedAt').toDate();
      expect(archivedAt).toBeInstanceOf(Date);
      expect(archived.get('updatedAt').toDate().getTime()).toBe(archivedAt.getTime());

      expect((await post(doneId, 'archive')).status).toBe(200);
      expect((await store.doc('tasks', doneId).get()).get('archivedAt').toDate()).toEqual(
        archivedAt,
      );

      expect((await post(doneId, 'restore')).status).toBe(200);
      const restored = await store.doc('tasks', doneId).get();
      expect(restored.get('archivedAt')).toBeNull();
      expect(restored.get('updatedAt').toDate().getTime()).toBeGreaterThanOrEqual(
        archivedAt.getTime(),
      );
    });

    it('refuses non-terminal, foreign, missing, and malformed tasks without writing', async () => {
      expect((await post(runningId, 'archive')).status).toBe(409);
      expect((await post(foreignId, 'archive')).status).toBe(409);
      expect((await post(randomUUID(), 'archive')).status).toBe(409);
      expect((await store.doc('tasks', runningId).get()).get('archivedAt')).toBeNull();
      expect((await store.doc('tasks', foreignId).get()).get('archivedAt')).toBeNull();
      await store.doc('tasks', doneId).update({ archivedAt: 'malformed' });
      expect((await post(doneId, 'archive')).status).toBe(409);
      expect((await store.doc('tasks', doneId).get()).get('archivedAt')).toBe('malformed');
    });

    it('requires auth and denies every other Firestore Activity mutation', async () => {
      auth.allowed.mockResolvedValue(false);
      expect((await post(doneId, 'archive')).status).toBe(401);
      expect((await post(retryId, 'retry')).status).toBe(401);
      expect((await post(cancelId, 'cancel')).status).toBe(401);
      auth.allowed.mockResolvedValue(true);
      expect((await post(doneId, 'archive-old')).status).toBe(503);
      expect((await store.doc('tasks', doneId).get()).get('archivedAt')).toBeNull();
    });

    it('revokes only owner autonomy grants and preserves an existing revocation', async () => {
      expect((await post(autonomyId, 'revoke-autonomy')).status).toBe(200);
      const revoked = await store.doc('tasks', autonomyId).get();
      const revokedAt = revoked.get('autonomyGrant').revokedAt;
      expect(typeof revokedAt).toBe('string');
      expect(revoked.get('updatedAt').toDate()).toBeInstanceOf(Date);
      expect((await post(autonomyId, 'revoke-autonomy')).status).toBe(200);
      expect((await store.doc('tasks', autonomyId).get()).get('autonomyGrant').revokedAt).toBe(
        revokedAt,
      );
      expect((await post(foreignId, 'revoke-autonomy')).status).toBe(200);
      expect((await store.doc('tasks', foreignId).get()).get('autonomyGrant')).toBeUndefined();
    });

    it('raises a stalled task budget with its runnable transition and queue intent atomically', async () => {
      expect((await post(attentionId, 'raise-budget', { budgetUsdLimit: 1 })).status).toBe(200);
      const task = await store.doc('tasks', attentionId).get();
      expect(task.get('status')).toBe('pending');
      expect(task.get('budgetUsdLimit')).toBe('1.0000');
      expect(task.get('queueGeneration')).toBe(5);
      expect(task.get('attempt')).toBe(0);
      expect(task.get('state')).toEqual({ checkpoint: 'continue here' });
      expect(task.get('runAfter')).toBeNull();
      expect(task.get('lockedUntil')).toBeNull();
      const intents = await store.collection('outbox').get();
      expect(intents.size).toBe(1);
      expect(intents.docs[0]?.get('taskId')).toBe(attentionId);
      expect(intents.docs[0]?.get('generation')).toBe(5);
    });

    it('retries an owner task once with an atomic, generation-scoped wake intent', async () => {
      const [first, duplicate] = await Promise.all([
        post(retryId, 'retry'),
        post(retryId, 'retry'),
      ]);
      expect(first.status).toBe(200);
      expect(duplicate.status).toBe(200);
      const task = await store.doc('tasks', retryId).get();
      expect(task.get('status')).toBe('pending');
      expect(task.get('queueGeneration')).toBe(3);
      expect(task.get('attempt')).toBe(0);
      expect(task.get('state')).toEqual({ checkpoint: 'continue here' });
      expect(task.get('runAfter')).toBeNull();
      expect(task.get('lockedUntil')).toBeNull();
      expect(task.get('leaseToken')).toBeNull();
      const intents = await store.collection('outbox').get();
      expect(intents.size).toBe(1);
      expect(intents.docs[0]?.get('taskId')).toBe(retryId);
      expect(intents.docs[0]?.get('generation')).toBe(3);
    });

    it('cancels an active owner task and fences its worker lease idempotently', async () => {
      expect((await post(cancelId, 'cancel')).status).toBe(200);
      const cancelled = await store.doc('tasks', cancelId).get();
      expect(cancelled.get('status')).toBe('cancelled');
      expect(cancelled.get('leaseToken')).toBeNull();
      expect(cancelled.get('lockedUntil')).toBeNull();
      expect(cancelled.get('runAfter')).toBeNull();
      expect((await post(cancelId, 'cancel')).status).toBe(200);
      expect((await store.doc('tasks', cancelId).get()).get('status')).toBe('cancelled');
      expect((await post(foreignId, 'cancel')).status).toBe(409);
    });

    it('validates budget input and fences both owner controls during privacy erasure', async () => {
      expect((await post(attentionId, 'raise-budget', { budgetUsdLimit: '1' })).status).toBe(400);
      for (const budgetUsdLimit of [0, 0.25, 10_001])
        expect((await post(attentionId, 'raise-budget', { budgetUsdLimit })).status).toBe(409);
      expect((await post(attentionId, 'raise-budget', { budgetUsdLimit: Number.NaN })).status).toBe(
        400,
      );
      expect((await post(attentionId, 'raise-budget', { budgetUsdLimit: 1 })).status).toBe(200);

      const secondAttentionId = randomUUID();
      await store.doc('tasks', secondAttentionId).set({
        ...taskFixture({
          id: secondAttentionId,
          agentId,
          conversationId: randomUUID(),
          reminderId: '',
        }),
        status: 'needs_attention',
      });
      await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
      try {
        expect((await post(autonomyId, 'revoke-autonomy')).status).toBe(409);
        expect((await post(secondAttentionId, 'raise-budget', { budgetUsdLimit: 1 })).status).toBe(
          409,
        );
        expect((await post(retryId, 'retry')).status).toBe(409);
        expect((await post(cancelId, 'cancel')).status).toBe(409);
      } finally {
        await store.doc('privacyErasureJobs', agentId).delete();
      }
      expect((await store.doc('tasks', autonomyId).get()).get('autonomyGrant').revokedAt).toBe(
        undefined,
      );
      expect((await store.doc('tasks', secondAttentionId).get()).get('status')).toBe(
        'needs_attention',
      );
      expect((await store.doc('tasks', retryId).get()).get('status')).toBe('needs_attention');
      expect((await store.doc('tasks', cancelId).get()).get('status')).toBe('running');
    });

    it('fails closed for active erasure or ambiguous configured ownership', async () => {
      await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
      try {
        expect((await post(doneId, 'archive')).status).toBe(409);
      } finally {
        await store.doc('privacyErasureJobs', agentId).delete();
      }
      await store.doc('agents', foreignAgentId).set({ id: foreignAgentId });
      try {
        expect((await post(doneId, 'archive')).status).toBe(409);
      } finally {
        await store.doc('agents', foreignAgentId).delete();
      }
      expect((await store.doc('tasks', doneId).get()).get('archivedAt')).toBeNull();
    });
  },
);
