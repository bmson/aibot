import { randomUUID } from 'node:crypto';
import { createInstallationStore, FirestoreScheduleRepository } from '@assistant/firestore';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)(
  'Firestore mobile workspace settings with PostgreSQL offline',
  () => {
    const installationId = `workspace-settings-${randomUUID()}`;
    const agentId = randomUUID();
    const foreignId = randomUUID();
    const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
    const schedules = new FirestoreScheduleRepository(store);
    const now = new Date('2026-09-22T12:00:00.000Z');
    const agent = (id: string, name: string, createdAt: Date) => ({
      id,
      name,
      email: `${id}@example.test`,
      calendarId: null,
      phoneE164: null,
      avatarUrl: null,
      signature: `${name} signature`,
      timezone: 'UTC',
      locale: 'en-US',
      workspacePrefix: name,
      browserProfilePath: null,
      credentialRefs: {},
      createdAt,
      updatedAt: createdAt,
    });

    beforeAll(async () => {
      vi.stubEnv('DATABASE_URL', 'postgres://assistant:assistant@127.0.0.1:1/offline_test');
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
      vi.stubEnv('CANARY_ENABLED', 'false');
      vi.stubEnv('LOCATION_PING_SECRET', '');
      vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
      await Promise.all([
        store.doc('agents', foreignId).set(agent(foreignId, 'Foreign', new Date(0))),
        store.doc('agents', agentId).set(agent(agentId, 'Owner', now)),
      ]);
    });

    afterAll(async () => {
      await store.db.recursiveDelete(store.root);
      await store.db.terminate();
      vi.unstubAllEnvs();
    });

    it('projects configured owner, schedules, reminders, policies, and goal count', async () => {
      const { getDb, getWorkspaceSettings } = await import('./server.js');
      expect(() => getDb()).toThrow('PostgreSQL-backed web surface is unavailable');

      const generic = await schedules.ensure({
        agentId,
        name: 'daily-job',
        cron: '0 9 * * *',
        taskTemplate: {},
        nextRunAt: new Date('2026-09-23T09:00:00.000Z'),
      });
      const reminder = await schedules.ensure({
        agentId,
        name: `reminder:${randomUUID()}`,
        cron: '0 10 * * *',
        taskTemplate: { reminderKind: 'once', reminderText: 'Bring sunglasses' },
        nextRunAt: new Date('2026-09-23T10:00:00.000Z'),
      });
      await schedules.ensure({
        agentId,
        name: 'goal:weekly',
        cron: '0 11 * * *',
        taskTemplate: {},
        nextRunAt: null,
      });
      await schedules.ensure({
        agentId: foreignId,
        name: 'foreign-job',
        cron: '0 12 * * *',
        taskTemplate: {},
        nextRunAt: null,
      });
      const policyId = randomUUID();
      const foreignPolicyId = randomUUID();
      const policy = (id: string, ownerId: string, toolName: string) => ({
        id,
        agentId: ownerId,
        toolName,
        templateKey: 'always-ask',
        effect: 'ask',
        enabled: true,
        createdVia: 'owner',
        match: {},
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      await Promise.all([
        store.doc('approvalPolicies', policyId).set(policy(policyId, agentId, 'gmail.send')),
        store
          .doc('approvalPolicies', foreignPolicyId)
          .set(policy(foreignPolicyId, foreignId, 'calendar.delete')),
      ]);

      const overview = await getWorkspaceSettings();
      expect(overview.agent).toMatchObject({ id: agentId, name: 'Owner' });
      expect(overview.schedules.map((row) => row.id)).toEqual([generic.id]);
      expect(overview.reminders).toMatchObject([
        { id: reminder.id, text: 'Bring sunglasses', kind: 'once', status: 'scheduled' },
      ]);
      expect(overview.policies.map((row) => row.id)).toEqual([policyId]);
      expect(overview.goalAutomationCount).toBe(1);
    }, 30_000);

    it('fails closed for a malformed configured owner and keeps workspace writes closed', async () => {
      const { getWorkspaceSettings } = await import('./server.js');
      const { proxy } = await import('../proxy.js');
      expect(proxy(new NextRequest('http://localhost/api/mobile/v1/workspace')).status).toBe(200);
      expect(
        proxy(new NextRequest('http://localhost/api/mobile/v1/workspace', { method: 'POST' }))
          .status,
      ).toBe(503);
      await store.doc('agents', agentId).update({ id: foreignId });
      await expect(getWorkspaceSettings()).rejects.toThrow('Configured agent record is malformed');
      await store.doc('agents', agentId).update({ id: agentId, locale: 42 });
      await expect(getWorkspaceSettings()).rejects.toThrow('Configured agent record is malformed');
    });
  },
);
