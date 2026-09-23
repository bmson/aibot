import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore, FirestoreScheduleRepository } from '@assistant/firestore';
import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ owner: vi.fn() }));
vi.mock('@/auth', () => ({ requireOwner: auth.owner }));

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore owner settings page with PostgreSQL offline', () => {
  const installationId = `web-settings-${randomUUID()}`;
  const agentId = randomUUID();
  const foreignAgentId = randomUUID();
  const policyId = randomUUID();
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
  let page: typeof import('./page.js');

  beforeAll(async () => {
    vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
    vi.stubEnv('DATABASE_URL', 'postgres://offline:offline@127.0.0.1:1/offline_test');
    vi.stubEnv('GCP_PROJECT', 'demo-assistant-test');
    vi.stubEnv('ASSISTANT_WORKSPACE_ID', installationId);
    vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
    vi.stubEnv('ASSISTANT_MODULES', 'minimal');
    vi.stubEnv('QUEUE_DRIVER', 'local');
    vi.stubEnv('CANARY_ENABLED', 'false');
    vi.stubEnv('LOCATION_PING_SECRET', '');
    resetConfigForTest();
    auth.owner.mockResolvedValue({ user: { email: 'owner@example.test' } });
    page = await import('./page.js');

    const now = new Date();
    await store.doc('agents', agentId).set({
      id: agentId,
      name: 'Owner assistant',
      email: 'owner@example.test',
      calendarId: null,
      phoneE164: null,
      avatarUrl: null,
      signature: 'Regards, assistant',
      timezone: 'UTC',
      locale: 'en-US',
      workspacePrefix: 'test',
      browserProfilePath: null,
      credentialRefs: {},
      createdAt: now,
      updatedAt: now,
    });
    await new FirestoreScheduleRepository(store).ensure({
      agentId,
      name: 'daily-job',
      cron: '0 9 * * *',
      taskTemplate: {},
      nextRunAt: new Date(now.getTime() + 86_400_000),
    });
    await store.doc('notificationPrefs', agentId).set({
      agentId,
      quietStartMin: 22 * 60,
      quietEndMin: 7 * 60,
      ambientDailyCap: 3,
      createdAt: now,
      updatedAt: now,
    });
    await store.doc('approvalPolicies', policyId).set({
      id: policyId,
      agentId,
      toolName: 'gmail.send',
      templateKey: 'gmail.send.to_recipient',
      effect: 'allow',
      enabled: true,
      createdVia: 'owner',
      match: { recipient: 'trusted@example.test' },
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  it('admits only GET for settings and renders portable settings without write controls', async () => {
    const { proxy } = await import('../../proxy.js');
    expect(proxy(new NextRequest('http://localhost/settings')).status).toBe(200);
    expect(proxy(new NextRequest('http://localhost/settings', { method: 'POST' })).status).toBe(
      503,
    );
    const html = renderToStaticMarkup(await page.default());
    expect(html).toContain('Owner assistant');
    expect(html).toContain('Regards, assistant');
    expect(html).toContain('22:00');
    expect(html).toContain('Daily ping limit');
    expect(html).toContain('daily job');
    expect(html).toContain('Send email to an approved recipient');
    expect(html).toContain('trusted@example.test');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('/costs');
    expect(html).not.toContain('MCP connections');
  });

  it('requires owner authentication before reading', async () => {
    auth.owner.mockRejectedValueOnce(new Error('owner authentication required'));
    await expect(page.default()).rejects.toThrow('owner authentication required');
  });

  it('fails closed during privacy erasure', async () => {
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    try {
      await expect(page.default()).rejects.toThrow('Privacy erasure is in progress');
    } finally {
      await store.doc('privacyErasureJobs', agentId).delete();
    }
  });

  it('refuses another configured owner in the installation', async () => {
    await store.doc('agents', foreignAgentId).set({ id: foreignAgentId });
    try {
      await expect(page.default()).rejects.toThrow('one matching configured owner');
    } finally {
      await store.doc('agents', foreignAgentId).delete();
    }
  });
});
