import { randomUUID } from 'node:crypto';
import { listApprovalInbox } from '@assistant/application/approvals';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore, FirestoreApprovalRepository } from '@assistant/firestore';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getApprovalStore } from '@/lib/approval-store';
import { getDb } from '@/lib/server';
import { proxy } from '@/proxy';
import {
  approveAndRemember,
  editAndApprove,
  resolveApprovalInline,
  resolveApprovalsInline,
} from './actions';

const auth = vi.hoisted(() => ({ owner: vi.fn() }));
vi.mock('@/auth', () => ({ requireOwner: auth.owner }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore web Approvals with PostgreSQL offline', () => {
  const installationId = `web-approvals-${randomUUID()}`;
  const agentId = randomUUID();
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
  const approvals = new FirestoreApprovalRepository(store);

  beforeAll(() => {
    vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
    vi.stubEnv('DATABASE_URL', 'postgres://offline:offline@127.0.0.1:1/offline_test');
    vi.stubEnv('GCP_PROJECT', 'demo-assistant-test');
    vi.stubEnv('ASSISTANT_WORKSPACE_ID', installationId);
    vi.stubEnv('FIRESTORE_DATABASE_ID', '(default)');
    vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
    vi.stubEnv(
      'FIRESTORE_EMBEDDING_SPACE',
      '{"provider":"vertex","model":"fixture","dimensions":1536,"revision":"1"}',
    );
    vi.stubEnv('ASSISTANT_MODULES', 'minimal');
    vi.stubEnv('QUEUE_DRIVER', 'local');
    resetConfigForTest();
  });

  beforeEach(async () => {
    auth.owner.mockResolvedValue(undefined);
    await store.db.recursiveDelete(store.root);
    await store.doc('agents', agentId).set({ id: agentId, name: 'Assistant' });
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  async function createApproval(taskAgentId = agentId, toolName = 'test.approve') {
    const taskId = randomUUID();
    await store.doc('tasks', taskId).set({
      id: taskId,
      agentId: taskAgentId,
      type: 'request',
      trust: 'owner',
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
      args: toolName === 'gmail.send' ? { to: ['owner@example.com'] } : { value: 1 },
      decision: { riskTier: 'high', reason: 'web action integration' },
      summary: 'Approve a test action',
    });
  }

  it('shows only owner approvals and allows the web action route with PostgreSQL fenced', async () => {
    const own = await createApproval();
    await createApproval(randomUUID());
    expect(() => getDb()).toThrow('PostgreSQL-backed web surface is unavailable');
    expect(proxy(new NextRequest('http://localhost/approvals')).status).toBe(200);
    expect(proxy(new NextRequest('http://localhost/approvals', { method: 'POST' })).status).toBe(
      200,
    );
    const inbox = await listApprovalInbox(getApprovalStore());
    expect(inbox.pending.map((item) => item.approval.id)).toEqual([own.approvalId]);
  });

  it('resolves bounded batches while rejecting another agent approval', async () => {
    const own = await createApproval();
    const foreign = await createApproval(randomUUID());
    const result = await resolveApprovalsInline([own.approvalId, foreign.approvalId], 'approved');
    expect(result.failures).toEqual([
      { approvalId: foreign.approvalId, error: expect.any(String) },
    ]);
    expect((await store.doc('approvals', own.approvalId).get()).get('status')).toBe('approved');
    expect((await store.doc('approvals', foreign.approvalId).get()).get('status')).toBe('pending');
  });

  it('edits an approval and saves the narrow recipient rule', async () => {
    const editable = await createApproval();
    const form = new FormData();
    form.set('approvalId', editable.approvalId);
    form.set('payload', '{"value":2}');
    expect(await editAndApprove({ error: null }, form)).toEqual({ error: null });
    expect(
      (await store.doc('approvals', editable.approvalId).get()).get('resolutionPayload'),
    ).toEqual({
      value: 2,
    });

    const remembered = await createApproval(agentId, 'gmail.send');
    await approveAndRemember(remembered.approvalId);
    const policies = await store
      .collection('approvalPolicies')
      .where('agentId', '==', agentId)
      .get();
    expect(policies.docs.map((doc) => doc.get('match'))).toEqual([
      { recipient: 'owner@example.com' },
    ]);
  });

  it('refuses a decision during privacy erasure', async () => {
    const approval = await createApproval();
    await store.doc('privacyErasureJobs', agentId).set({
      agentId,
      generation: randomUUID(),
      status: 'active',
    });
    await expect(resolveApprovalInline(approval.approvalId, 'denied')).rejects.toThrow(
      'Privacy erasure is in progress',
    );
    expect((await store.doc('approvals', approval.approvalId).get()).get('status')).toBe('pending');
  });
});
