import { randomUUID } from 'node:crypto';
import { commandContract, taskFixture } from '@assistant/persistence/testing';
import { eq } from 'drizzle-orm';
import { createDb } from './client.js';
import { createPostgresCostRepository } from './cost-repository.js';
import { createPostgresMessageRepository } from './message-repository.js';
import { createPostgresReminderRepository } from './reminder-repository.js';
import {
  agents,
  conversations,
  costEvents,
  costReservations,
  messages,
  schedules,
  tasks,
} from './schema.js';
import { createPostgresTaskRepository } from './task-lifecycle-repository.js';

commandContract('PostgreSQL persistence contract', async () => {
  const url = process.env.DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  const db = createDb(url);
  const [agent] = await db.select().from(agents).limit(1);
  if (!agent) throw new Error('Seed the test database');
  const taskId = randomUUID(),
    conversationId = randomUUID(),
    reminderId = randomUUID();
  await db
    .insert(conversations)
    .values({ id: conversationId, agentId: agent.id, channel: 'chat', trust: 'owner' });
  await db.insert(schedules).values({
    id: reminderId,
    agentId: agent.id,
    name: `reminder:${reminderId}`,
    cron: '* * * * *',
    taskTemplate: { reminderKind: 'once', reminderText: 'contract' },
  });
  await db
    .insert(tasks)
    .values(taskFixture({ id: taskId, agentId: agent.id, conversationId, reminderId }));
  return {
    agentId: agent.id,
    taskId,
    conversationId,
    reminderId,
    costs: createPostgresCostRepository(db),
    leases: createPostgresTaskRepository(db),
    messages: createPostgresMessageRepository(db),
    reminders: createPostgresReminderRepository(db),
    patchTask: async (patch) => {
      await db.update(tasks).set(patch).where(eq(tasks.id, taskId));
    },
    readTask: async () => {
      const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
      if (!task) throw new Error('Missing test task');
      return task;
    },
    messageCount: async () =>
      (await db.select().from(messages).where(eq(messages.conversationId, conversationId))).length,
    dispose: async () => {
      try {
        await db.delete(costEvents).where(eq(costEvents.taskId, taskId));
        await db.delete(costReservations).where(eq(costReservations.taskId, taskId));
        await db.delete(messages).where(eq(messages.conversationId, conversationId));
        await db.delete(tasks).where(eq(tasks.id, taskId));
        await db.delete(schedules).where(eq(schedules.id, reminderId));
        await db.delete(conversations).where(eq(conversations.id, conversationId));
      } finally {
        await db.$client.end();
      }
    },
  };
});
