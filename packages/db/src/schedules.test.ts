import { randomUUID } from 'node:crypto';
import type { Records, ScheduleRepository } from '@assistant/persistence';
import { scheduleContract } from '@assistant/persistence/testing';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import { createPostgresReminderRepository } from './reminder-repository.js';
import { createPostgresScheduleRepository } from './schedule-repository.js';
import { agents, conversations, schedules, tasks } from './schema.js';
import { createPostgresTaskRepository } from './task-lifecycle-repository.js';

function testDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  return url;
}

scheduleContract('PostgreSQL schedule persistence contract', async () => {
  const db = createDb(testDatabaseUrl());
  const [agent] = await db.select().from(agents).limit(1);
  if (!agent) throw new Error('Seed the test database');

  const conversationId = randomUUID();
  const scheduleIds = new Set<string>();
  const taskIds = new Set<string>();
  await db.insert(conversations).values({
    id: conversationId,
    agentId: agent.id,
    channel: 'chat',
    trust: 'owner',
  });

  const base = createPostgresScheduleRepository(db);
  const repository: ScheduleRepository = {
    ...base,
    ensure: async (input) => {
      const schedule = await base.ensure(input);
      scheduleIds.add(schedule.id);
      return schedule;
    },
    commitOccurrence: async (input) => {
      const result = await base.commitOccurrence(input);
      if (result?.task) taskIds.add(result.task.task.id);
      return result;
    },
  };

  return {
    agentId: agent.id,
    conversationId,
    repository,
    reminders: createPostgresReminderRepository(db),
    tasks: createPostgresTaskRepository(db),
    readSchedule: async (id: string) => {
      const [schedule] = await db.select().from(schedules).where(eq(schedules.id, id));
      if (!schedule) throw new Error(`Missing test schedule ${id}`);
      return schedule;
    },
    patchSchedule: async (id: string, patch: Partial<Records['schedules']>) => {
      await db.update(schedules).set(patch).where(eq(schedules.id, id));
    },
    listTasks: async (scheduleId: string) =>
      db
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.agentId, agent.id),
            sql`${tasks.trigger}->'payload'->>'scheduleId' = ${scheduleId}`,
          ),
        ),
    dispose: async () => {
      try {
        if (taskIds.size > 0) await db.delete(tasks).where(inArray(tasks.id, [...taskIds]));
        // A contract case may enqueue through the task repository directly;
        // remove those rows by the schedule IDs this fixture created too.
        for (const scheduleId of scheduleIds)
          await db
            .delete(tasks)
            .where(sql`${tasks.trigger}->'payload'->>'scheduleId' = ${scheduleId}`);
        if (scheduleIds.size > 0)
          await db.delete(schedules).where(inArray(schedules.id, [...scheduleIds]));
        await db.delete(conversations).where(eq(conversations.id, conversationId));
      } finally {
        await db.$client.end();
      }
    },
  };
});

it('rolls back a schedule occurrence committed inside an outer transaction', async () => {
  const db = createDb(testDatabaseUrl());
  const scheduleId = randomUUID();
  const conversationId = randomUUID();
  const now = new Date(Date.now() - 1_000);
  const externalEventId = `schedule:${scheduleId}:${now.toISOString()}`;
  try {
    const [agent] = await db.select().from(agents).limit(1);
    if (!agent) throw new Error('Seed the test database');
    await db.insert(conversations).values({
      id: conversationId,
      agentId: agent.id,
      channel: 'chat',
      trust: 'owner',
    });
    await db.insert(schedules).values({
      id: scheduleId,
      agentId: agent.id,
      name: `schedule:rollback:${scheduleId}`,
      cron: '* * * * *',
      taskTemplate: { type: 'scheduled' },
      enabled: true,
      nextRunAt: now,
    });
    const [expected] = await db.select().from(schedules).where(eq(schedules.id, scheduleId));
    if (!expected) throw new Error('Missing rollback schedule');

    await expect(
      db.transaction(async (tx) => {
        const repository = createPostgresScheduleRepository(tx as unknown as Db);
        const result = await repository.commitOccurrence({
          expected,
          now,
          mode: 'due',
          nextRunAt: new Date(now.getTime() + 60_000),
          enabled: true,
          task: {
            agentId: agent.id,
            type: 'scheduled',
            trust: 'assistant',
            trigger: {
              source: 'schedule',
              payload: { scheduleId, occurrenceId: externalEventId },
            },
            externalEventId,
          },
        });
        expect(result?.task?.created).toBe(true);
        throw new Error('outer transaction failed');
      }),
    ).rejects.toThrow('outer transaction failed');

    const [schedule] = await db.select().from(schedules).where(eq(schedules.id, scheduleId));
    expect(schedule).toMatchObject({ id: scheduleId, nextRunAt: now, lastRunAt: null });
    expect(await db.select().from(tasks).where(eq(tasks.externalEventId, externalEventId))).toEqual(
      [],
    );
  } finally {
    await db.delete(tasks).where(eq(tasks.externalEventId, externalEventId));
    await db.delete(schedules).where(eq(schedules.id, scheduleId));
    await db.delete(conversations).where(eq(conversations.id, conversationId));
    await db.$client.end();
  }
});
