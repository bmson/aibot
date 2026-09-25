import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore } from '@assistant/firestore';
import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyProposalAction, dismissProposalAction } from '@/app/improvements/actions';
import ImprovementsPage from '@/app/improvements/page';
import { getDb } from '@/lib/server';
import { proxy } from '@/proxy';
import { dismissAnomalyAction, suspendPolicyAction } from './actions';
import AnomaliesPage from './page';

const auth = vi.hoisted(() => ({ owner: vi.fn() }));
vi.mock('@/auth', () => ({ requireOwner: auth.owner }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore web anomalies and improvements', () => {
  const installationId = `web-reviews-${randomUUID()}`;
  const agentId = randomUUID();
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });

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

  async function anomaly(patch: Record<string, unknown> = {}): Promise<string> {
    const id = randomUUID();
    await store.doc('anomalies', id).set({
      id,
      agentId,
      status: 'open',
      kind: 'off_hours',
      toolName: 'gmail.send',
      detail: 'Sent mail at 03:00',
      observed: 4,
      expected: 0,
      toolCallIds: ['call-1', 'call-2'],
      policyId: null,
      createdAt: new Date('2026-09-22T03:00:00.000Z'),
      ...patch,
    });
    return id;
  }

  async function proposal(patch: Record<string, unknown> = {}): Promise<string> {
    const id = randomUUID();
    await store.doc('improvementProposals', id).set({
      id,
      agentId,
      status: 'open',
      kind: 'note',
      title: 'Batch calendar lookups',
      rationale: 'Three retries last week',
      change: { suggestion: 'Look up the week at once' },
      evidenceIds: ['task-1'],
      createdAt: new Date('2026-09-22T00:00:00.000Z'),
      ...patch,
    });
    return id;
  }

  it('serves both pages and their actions through the proxy with PostgreSQL fenced', () => {
    expect(() => getDb()).toThrow('PostgreSQL-backed web surface is unavailable');
    for (const path of ['/anomalies', '/improvements'])
      for (const method of ['GET', 'POST'])
        expect(proxy(new NextRequest(`http://localhost${path}`, { method })).status).toBe(200);
  });

  it('lists and resolves only the owner anomalies', async () => {
    const policyId = randomUUID();
    await store.doc('approvalPolicies', policyId).set({ id: policyId, agentId, enabled: true });
    const dismissed = await anomaly();
    const suspended = await anomaly({ policyId, detail: 'Burst of sends' });
    await anomaly({ agentId: randomUUID(), detail: 'Foreign anomaly' });

    const html = renderToStaticMarkup(await AnomaliesPage());
    expect(html).toContain('Sent mail at 03:00');
    expect(html).toContain('Burst of sends');
    expect(html).not.toContain('Foreign anomaly');

    await dismissAnomalyAction(dismissed);
    await suspendPolicyAction(suspended);
    expect((await store.doc('anomalies', dismissed).get()).get('status')).toBe('dismissed');
    expect((await store.doc('anomalies', suspended).get()).get('status')).toBe('suspended');
    expect((await store.doc('approvalPolicies', policyId).get()).get('enabled')).toBe(false);
    expect(renderToStaticMarkup(await AnomaliesPage())).toContain('Nothing unusual');
  });

  it('lists, applies, and dismisses owner improvement proposals', async () => {
    const applied = await proposal();
    const dismissed = await proposal({ title: 'Shorter drafts', kind: 'prompt' });
    await proposal({ agentId: randomUUID(), title: 'Foreign proposal' });

    const html = renderToStaticMarkup(await ImprovementsPage());
    expect(html).toContain('Batch calendar lookups');
    expect(html).toContain('Shorter drafts');
    expect(html).not.toContain('Foreign proposal');

    await applyProposalAction(applied);
    await dismissProposalAction(dismissed);
    expect((await store.doc('improvementProposals', applied).get()).get('status')).toBe('applied');
    expect((await store.doc('improvementProposals', dismissed).get()).get('status')).toBe(
      'dismissed',
    );
    expect(renderToStaticMarkup(await ImprovementsPage())).toContain('No open proposals');
  });

  it('requires the owner before any change', async () => {
    const id = await anomaly();
    auth.owner.mockRejectedValueOnce(new Error('unauthorized'));
    await expect(dismissAnomalyAction(id)).rejects.toThrow('unauthorized');
    expect((await store.doc('anomalies', id).get()).get('status')).toBe('open');
  });
});
