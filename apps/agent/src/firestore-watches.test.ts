import { loadConfig } from '@assistant/config';
import type { ModelRouter } from '@assistant/core';
import { runWatchSuggest } from '@assistant/core/workflow/watch-suggest';
import type { Db } from '@assistant/db';
import { createFirestoreExecutionPersistence, createInstallationStore } from '@assistant/firestore';
import { watchesModule } from '@assistant/modules';
import { ToolRegistry } from '@assistant/tools/registry';
import { afterAll, describe, expect, it } from 'vitest';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore watches module composition',
  () => {
    const store = createInstallationStore({
      projectId: process.env.GCLOUD_PROJECT ?? 'demo-assistant-test',
      databaseId: '(default)',
      installationId: `watch-module-${Date.now()}`,
    });
    afterAll(() => store.db.terminate());

    it('creates through Firestore without touching the SQL compatibility handle', async () => {
      const registry = new ToolRegistry();
      const persistence = createFirestoreExecutionPersistence(store, 'agent-a', {
        provider: 'test',
        model: 'embedding',
        dimensions: 1536,
        revision: '1',
      });
      const sql = new Proxy(
        {},
        {
          get() {
            throw new Error('SQL watch persistence was touched');
          },
        },
      ) as Db;
      watchesModule.create({
        config: loadConfig({ ASSISTANT_MODULES: 'watches' }),
        db: sql,
        persistence,
        registry,
        router: {} as never,
        workspace: {} as never,
        workspacePrefix: 'workspace/test',
        workspaceRoot: '/tmp/test',
        repoRoot: '/tmp/test',
      });
      const tool = registry.get('watch.create')?.tool;
      if (!tool) throw new Error('watch.create was not registered');
      const result = (await tool.execute(
        {
          name: 'Recruiter',
          expectedSenderEmails: ['recruiter@example.com'],
          tier: 'notify',
          expiresInDays: 30,
        },
        {
          agentId: 'agent-a',
          db: sql,
          now: () => new Date('2026-09-19T12:00:00Z'),
        } as never,
      )) as { watchId: string };
      expect((await persistence.watches.list('agent-a')).map((watch) => watch.id)).toContain(
        result.watchId,
      );
    });

    it('runs and deduplicates watch.suggest without touching SQL', async () => {
      const agentId = `agent-${Date.now()}`;
      const now = new Date('2026-09-19T12:00:00Z');
      await store.doc('agents', agentId).set({
        id: agentId,
        name: 'Assistant',
        timezone: 'UTC',
        createdAt: now,
        updatedAt: now,
      });
      const persistence = createFirestoreExecutionPersistence(store, agentId, {
        provider: 'test',
        model: 'embedding',
        dimensions: 1536,
        revision: '1',
      });
      const watch = await persistence.watches.create({
        agentId,
        kind: 'email',
        tier: 'suggest',
        name: 'Recruiter reply',
        match: {},
        maxFires: null,
        expiresAt: new Date('2026-10-19T12:00:00Z'),
      });
      // Migrated legacy watches may be conversationless. Preserve the existing
      // dashboard behavior by surfacing their cards in Notifications.
      await store.doc('watches', watch.id).update({ conversationId: null });
      await persistence.watches.recordFire({
        watchId: watch.id,
        agentId,
        triggerRef: 'gmail:reply',
        summary: 'A recruiter replied.',
        excerpt: 'Can you meet Thursday afternoon?',
        now,
      });
      const sql = new Proxy(
        {},
        {
          get() {
            throw new Error('SQL watch suggestion persistence was touched');
          },
        },
      ) as Db;
      const router = {
        async object() {
          return {
            ok: true,
            modelId: 'test',
            degraded: false,
            object: {
              worthSuggesting: true,
              summary: 'The recruiter replied — propose two Thursday times?',
              proposedAction: 'Draft a reply proposing two Thursday afternoon times.',
            },
          };
        },
      } as unknown as ModelRouter;
      const run = () =>
        runWatchSuggest(
          { db: sql, router, persistence },
          { agentId, watchId: watch.id, triggerRef: 'gmail:reply' },
        );

      await expect(run()).resolves.toMatchObject({ suggested: true });
      await expect(run()).resolves.toMatchObject({ suggested: true });
      expect(
        (await store.collection('suggestions').where('agentId', '==', agentId).get()).size,
      ).toBe(1);
      const notifications = await store
        .collection('conversations')
        .where('agentId', '==', agentId)
        .where('title', '==', 'Notifications')
        .get();
      expect(notifications.size).toBe(1);
      const notification = notifications.docs[0];
      expect(notification?.get('trust')).toBe('assistant');
      expect(
        (
          await store
            .collection('messages')
            .where('conversationId', '==', notification?.get('id'))
            .get()
        ).size,
      ).toBe(1);
    });
  },
);
