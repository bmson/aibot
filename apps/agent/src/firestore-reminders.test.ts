import { randomUUID } from 'node:crypto';
import { loadConfig } from '@assistant/config';
import type { Db } from '@assistant/db';
import {
  createInstallationStore,
  FirestoreReminderRepository,
  FirestoreScheduleRepository,
} from '@assistant/firestore';
import { remindersModule } from '@assistant/modules';
import { ToolRegistry } from '@assistant/tools/registry';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore reminders module composition',
  () => {
    const agentId = randomUUID();
    const store = createInstallationStore({
      projectId: process.env.GCLOUD_PROJECT ?? 'demo-assistant-test',
      databaseId: '(default)',
      installationId: `reminders-${randomUUID()}`,
    });
    const db = new Proxy(
      {},
      {
        get(_target, property) {
          throw new Error(`SQL reminder persistence was touched: ${String(property)}`);
        },
      },
    ) as Db;
    let registry: ToolRegistry;
    const portableReminders = {
      schedules: new FirestoreScheduleRepository(store),
      reminders: new FirestoreReminderRepository(store),
      getTimezone: async (requestedAgentId: string) => {
        if (requestedAgentId !== agentId) throw new Error('wrong reminder owner');
        return 'America/Los_Angeles';
      },
    };

    beforeEach(() => {
      vi.stubEnv('METADATA_SERVER_DETECTION', 'none');
      registry = new ToolRegistry();
      remindersModule.create({
        config: loadConfig({ ASSISTANT_MODULES: 'reminders' }),
        db,
        registry,
        router: {} as never,
        workspace: {} as never,
        workspacePrefix: 'workspace/test',
        workspaceRoot: '/tmp/test',
        repoRoot: '/tmp/test',
        persistence: {} as never,
        portableReminders,
      });
    });

    afterEach(async () => {
      await store.db.recursiveDelete(store.root);
      vi.unstubAllEnvs();
    });

    afterAll(() => store.db.terminate());

    function context() {
      return {
        taskId: randomUUID(),
        agentId,
        trust: 'owner',
        tainted: false,
        db,
        now: () => new Date('2026-09-23T16:00:00.000Z'),
        signal: new AbortController().signal,
        log: async () => {},
      } as never;
    }

    function reminderTool(name: string) {
      const tool = registry.get(name)?.tool;
      if (!tool) throw new Error(`${name} was not registered`);
      return tool;
    }

    it('creates ordinary one-time reminders with owner timezone and scheduled task template', async () => {
      const created = (await reminderTool('reminder.create').execute(
        { text: 'Pick up the package', inMinutes: 15 },
        context(),
      )) as { reminderId: string; kind: string; timezone: string; nextFires: string };

      expect(created).toMatchObject({
        kind: 'once',
        timezone: 'America/Los_Angeles',
        nextFires: '2026-09-23T16:15:00.000Z',
      });
      const listed = (await reminderTool('reminder.list').execute({}, context())) as {
        reminders: Array<Record<string, unknown>>;
      };
      expect(listed.reminders).toContainEqual(
        expect.objectContaining({
          reminderId: created.reminderId,
          text: 'Pick up the package',
          kind: 'once',
          timezone: 'America/Los_Angeles',
        }),
      );
      const row = await portableReminders.schedules.listPage(agentId);
      const reminder = row.items.find((item) => item.id === created.reminderId);
      expect(reminder?.taskTemplate).toMatchObject({
        type: 'scheduled',
        job: 'reminder.notify',
        reminderKind: 'once',
        reminderText: 'Pick up the package',
        timezone: 'America/Los_Angeles',
      });
    });

    it('keeps recurring reminders recurring and reports ambiguous natural cancellation', async () => {
      const first = (await reminderTool('reminder.create').execute(
        { text: 'Buy sunglasses', time: '09:00', weekdays: [1, 3] },
        context(),
      )) as { reminderId: string; kind: string };
      const second = (await reminderTool('reminder.create').execute(
        { text: 'Clean sunglasses', time: '10:00', weekdays: [1, 3] },
        context(),
      )) as { reminderId: string; kind: string };
      expect(first.kind).toBe('recurring');
      expect(second.kind).toBe('recurring');

      const ambiguous = await reminderTool('reminder.cancel').execute(
        { query: 'sunglasses' },
        context(),
      );
      expect(ambiguous).toMatchObject({ cancelled: false, reason: 'ambiguous' });

      const cancelled = await reminderTool('reminder.cancel').execute(
        { query: 'the buy sunglasses reminder' },
        context(),
      );
      expect(cancelled).toMatchObject({ cancelled: true, reminderId: first.reminderId });
      const listed = (await reminderTool('reminder.list').execute({}, context())) as {
        reminders: Array<{ reminderId: string }>;
      };
      expect(listed.reminders.map((item) => item.reminderId)).toEqual([second.reminderId]);
    });
  },
);
