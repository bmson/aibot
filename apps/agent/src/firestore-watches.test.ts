import { loadConfig } from '@assistant/config';
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
  },
);
