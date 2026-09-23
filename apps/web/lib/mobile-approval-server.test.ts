import { randomUUID } from 'node:crypto';
import { createInstallationStore, FirestoreApprovalRepository } from '@assistant/firestore';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ mobile: vi.fn() }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: auth.mobile,
  mobileJson: (body: unknown, init?: ResponseInit) => Response.json(body, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)(
  'Firestore mobile approval decisions with PostgreSQL offline',
  () => {
    const installationId = `mobile-approvals-${randomUUID()}`;
    const agentId = randomUUID();
    const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
    const approvals = new FirestoreApprovalRepository(store);
    const base = 'http://localhost/api/mobile/v1/approvals';
    let post: typeof import('../app/api/mobile/v1/approvals/[id]/route.js').POST;

    beforeAll(async () => {
      vi.stubEnv('DATABASE_URL', 'postgres://offline:offline@127.0.0.1:1/offline_test');
      vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
      vi.stubEnv('ASSISTANT_MODULES', 'minimal');
      vi.stubEnv('ASSISTANT_WORKSPACE_ID', installationId);
      vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
      vi.stubEnv(
        'FIRESTORE_EMBEDDING_SPACE',
        '{"provider":"openai","model":"text-embedding-3-small","dimensions":1536,"revision":"1"}',
      );
      vi.stubEnv('GCP_PROJECT', 'demo-assistant-test');
      vi.stubEnv('QUEUE_DRIVER', 'local');
      auth.mobile.mockResolvedValue(true);
      ({ POST: post } = await import('../app/api/mobile/v1/approvals/[id]/route.js'));
      await store.doc('agents', agentId).set({ id: agentId, name: 'Assistant' });
    });

    afterAll(async () => {
      await store.db.recursiveDelete(store.root);
      await store.db.terminate();
      vi.unstubAllEnvs();
    });

    async function createApproval(
      toolName = 'gmail.send',
      args: Record<string, unknown> = { to: ['owner@example.com'] },
      taskAgentId = agentId,
    ) {
      const taskId = randomUUID();
      await store.doc('tasks', taskId).set({
        id: taskId,
        agentId: taskAgentId,
        status: 'waiting_approval',
        conversationId: randomUUID(),
        state: {},
        updatedAt: new Date(),
        queueGeneration: 0,
        attempt: 0,
      });
      return approvals.create({
        taskId,
        step: 1,
        toolName,
        args,
        decision: { riskTier: 'high', reason: 'mobile route integration' },
        summary: 'Approve the test action',
      });
    }

    async function decide(id: string, body: unknown) {
      return post(
        new Request(`${base}/${id}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id }) },
      );
    }

    it('approves, denies, and edits Firestore approvals while the PostgreSQL accessor is fenced', async () => {
      const { NextRequest } = await import('next/server');
      const { proxy } = await import('../proxy.js');
      expect(
        proxy(
          new NextRequest(`http://localhost/api/mobile/v1/approvals/${randomUUID()}`, {
            method: 'POST',
          }),
        ).status,
      ).toBe(200);
      expect(
        proxy(
          new NextRequest(`http://localhost/api/mobile/v1/approvals/${randomUUID()}`, {
            method: 'GET',
          }),
        ).status,
      ).toBe(503);

      const { getDb } = await import('./server.js');
      expect(() => getDb()).toThrow('PostgreSQL-backed web surface is unavailable');

      const unauthenticated = await createApproval('test.auth', { value: 'private' });
      auth.mobile.mockResolvedValueOnce(false);
      expect((await decide(unauthenticated.approvalId, { decision: 'approved' })).status).toBe(401);
      expect((await store.doc('approvals', unauthenticated.approvalId).get()).get('status')).toBe(
        'pending',
      );

      const approved = await createApproval('test.approve', { value: 1 });
      expect((await decide(approved.approvalId, { decision: 'approved' })).status).toBe(200);
      expect((await store.doc('approvals', approved.approvalId).get()).get('status')).toBe(
        'approved',
      );

      const denied = await createApproval('test.deny', { value: 2 });
      expect((await decide(denied.approvalId, { decision: 'denied' })).status).toBe(200);
      expect((await store.doc('approvals', denied.approvalId).get()).get('status')).toBe('denied');

      const edited = await createApproval('test.edit', { value: 3 });
      const editedResponse = await decide(edited.approvalId, {
        action: 'edit',
        payload: { value: 4 },
      });
      expect(editedResponse.status).toBe(200);
      expect(
        (await store.doc('approvals', edited.approvalId).get()).get('resolutionPayload'),
      ).toEqual({
        value: 4,
      });
    });

    it('remembers only the supported recipient-scoped Gmail rule in Firestore', async () => {
      const approval = await createApproval();
      expect((await decide(approval.approvalId, { action: 'remember' })).status).toBe(200);
      expect((await store.doc('approvals', approval.approvalId).get()).get('status')).toBe(
        'approved',
      );
      const policies = await store
        .collection('approvalPolicies')
        .where('agentId', '==', agentId)
        .get();
      expect(policies.docs.map((doc) => doc.data())).toEqual([
        expect.objectContaining({
          toolName: 'gmail.send',
          templateKey: 'gmail.send.to_recipient',
          match: { recipient: 'owner@example.com' },
          enabled: true,
        }),
      ]);
    });

    it("rejects another agent's approval without changing it", async () => {
      const approval = await createApproval('test.foreign', { value: 'private' }, randomUUID());
      const response = await decide(approval.approvalId, { decision: 'approved' });
      expect(response.status).toBe(409);
      expect((await store.doc('approvals', approval.approvalId).get()).get('status')).toBe(
        'pending',
      );
    });

    it('refuses a decision while owner privacy erasure is active', async () => {
      const approval = await createApproval('test.erasure', { value: 'private' });
      await store.doc('privacyErasureJobs', agentId).set({
        agentId,
        generation: randomUUID(),
        status: 'active',
      });

      await expect(decide(approval.approvalId, { decision: 'approved' })).rejects.toThrow(
        'Privacy erasure is in progress',
      );
      expect((await store.doc('approvals', approval.approvalId).get()).get('status')).toBe(
        'pending',
      );
      await store.doc('privacyErasureJobs', agentId).delete();
    });
  },
);
