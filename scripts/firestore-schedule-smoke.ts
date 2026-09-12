import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runScheduleBatch } from '@assistant/core/workflow/schedules';
import {
  FirestoreReminderRepository,
  FirestoreScheduleRepository,
  FirestoreTaskRepository,
  type InstallationStore,
} from '@assistant/firestore';

/** Synthetic schedule workload shared by emulator and isolated real Firestore validation. */
export async function firestoreScheduleSmoke(store: InstallationStore) {
  const now = new Date(Date.now() + 2_000);
  const timezone = 'UTC';
  const agentId = randomUUID();
  const conversationId = randomUUID();
  const schedules = new FirestoreScheduleRepository(store);
  const tasks = new FirestoreTaskRepository(store);
  const reminders = new FirestoreReminderRepository(store);

  await store.doc('conversations', conversationId).set({
    id: conversationId,
    createdAt: now,
    updatedAt: now,
    agentId,
    title: 'Firestore schedule smoke',
    archivedAt: null,
    channel: 'chat',
    trust: 'owner',
    modelOverride: null,
    isPrimary: false,
    metadata: {},
    lastReadAt: null,
  });

  const taskDocsFor = async (scheduleId: string) =>
    (await store.collection('tasks').where('trigger.payload.scheduleId', '==', scheduleId).get())
      .docs;

  const oneTime = await schedules.ensure({
    agentId,
    name: `reminder:${randomUUID()}`,
    cron: '* * * * *',
    taskTemplate: {
      type: 'scheduled',
      job: 'reminder.notify',
      reminderKind: 'once',
      reminderText: 'one-time schedule smoke',
      instruction: 'Deliver the one-time schedule smoke reminder.',
      conversationId,
      maxSteps: 3,
      budgetUsdLimit: '0.05',
    },
    nextRunAt: new Date(now.getTime() - 1_000),
  });
  const oneTimeOccurrence = `schedule:${oneTime.id}:${oneTime.nextRunAt?.toISOString()}`;

  const oneTimeRuns = await Promise.all(
    [0, 1].map(() =>
      runScheduleBatch(schedules, timezone, {
        now,
        isJobEnabled: () => true,
      }),
    ),
  );
  assert.equal(oneTimeRuns.flat().filter((row) => row.schedule === oneTime.name).length, 1);
  const oneTimeAfter = await schedules.getByName(agentId, oneTime.name);
  assert.ok(oneTimeAfter);
  assert.equal(oneTimeAfter.enabled, false);
  assert.equal(oneTimeAfter.nextRunAt, null);
  const oneTimeTasks = await taskDocsFor(oneTime.id);
  assert.equal(oneTimeTasks.length, 1);
  const oneTimeDoc = oneTimeTasks[0];
  assert.ok(oneTimeDoc);
  const oneTimeTaskId = String(oneTimeDoc.get('id'));
  assert.equal(oneTimeDoc.get('externalEventId'), oneTimeOccurrence);
  assert.deepEqual(oneTimeDoc.get('trigger.payload.occurrenceId'), oneTimeOccurrence);
  assert.equal(oneTimeDoc.get('trigger.payload.scheduleId'), oneTime.id);

  const oneTimeLease = await tasks.claim(oneTimeTaskId, 0);
  assert.ok(oneTimeLease);
  const oneTimeMessage = reminderMessage(conversationId, oneTimeTaskId, 'one-time schedule smoke');
  assert.equal(
    await reminders.deliver({
      agentId,
      reminderId: oneTime.id,
      occurrenceId: oneTimeOccurrence,
      lease: oneTimeLease,
      message: oneTimeMessage,
    }),
    true,
  );
  assert.equal(
    await reminders.deliver({
      agentId,
      reminderId: oneTime.id,
      occurrenceId: oneTimeOccurrence,
      lease: oneTimeLease,
      message: oneTimeMessage,
    }),
    false,
  );
  assert.equal((await reminders.cancel(agentId, oneTime.id, now)).cancelled, false);

  const recurring = await schedules.ensure({
    agentId,
    name: `reminder:${randomUUID()}`,
    cron: '* * * * *',
    taskTemplate: {
      type: 'scheduled',
      job: 'reminder.notify',
      reminderKind: 'recurring',
      reminderText: 'recurring schedule smoke',
      instruction: 'Deliver the recurring schedule smoke reminder.',
      conversationId,
      maxSteps: 3,
      budgetUsdLimit: '0.05',
    },
    nextRunAt: new Date(now.getTime() - 1_000),
  });
  const recurringRun = await runScheduleBatch(schedules, timezone, {
    now,
    isJobEnabled: () => true,
  });
  assert.equal(recurringRun.filter((row) => row.schedule === recurring.name).length, 1);
  const recurringAfter = await schedules.getByName(agentId, recurring.name);
  assert.ok(recurringAfter);
  assert.equal(recurringAfter.enabled, true);
  assert.ok(recurringAfter.nextRunAt && recurringAfter.nextRunAt > now);
  assert.equal((await taskDocsFor(recurring.id)).length, 1);

  const raced = await schedules.ensure({
    agentId,
    name: `reminder:${randomUUID()}`,
    cron: '* * * * *',
    taskTemplate: {
      type: 'scheduled',
      job: 'reminder.notify',
      reminderKind: 'recurring',
      reminderText: 'cancel race smoke',
      instruction: 'Deliver the cancellation race smoke reminder.',
      conversationId,
      maxSteps: 3,
      budgetUsdLimit: '0.05',
    },
    nextRunAt: new Date(now.getTime() - 1_000),
  });
  const [racedRun, racedCancel] = await Promise.all([
    runScheduleBatch(schedules, timezone, { now, isJobEnabled: () => true }),
    reminders.cancel(agentId, raced.id, now),
  ]);
  assert.equal(racedCancel.cancelled, true);
  const racedTasks = await taskDocsFor(raced.id);
  assert.ok(racedRun.filter((row) => row.schedule === raced.name).length <= 1);
  for (const task of racedTasks) assert.equal(task.get('status'), 'cancelled');

  const stale = await schedules.ensure({
    agentId,
    name: `reminder:${randomUUID()}`,
    cron: '* * * * *',
    taskTemplate: {
      type: 'scheduled',
      job: 'reminder.notify',
      reminderKind: 'recurring',
      reminderText: 'stale snapshot smoke',
      instruction: 'Deliver the stale snapshot smoke reminder.',
      conversationId,
      maxSteps: 3,
      budgetUsdLimit: '0.05',
    },
    nextRunAt: new Date(now.getTime() - 1_000),
  });
  await store.doc('schedules', stale.id).update({
    taskTemplate: { ...((stale.taskTemplate ?? {}) as Record<string, unknown>), edited: true },
  });
  const staleCommit = await schedules.commitOccurrence({
    expected: stale,
    now,
    mode: 'due',
    enabled: true,
    nextRunAt: new Date(now.getTime() + 60_000),
    task: null,
  });
  assert.equal(staleCommit, null);
  assert.equal((await taskDocsFor(stale.id)).length, 0);

  return {
    oneTimeAtomicFiring: 'passed',
    oneTimeDeliveryFence: 'passed',
    recurringAdvancement: 'passed',
    cancellationRace: 'passed',
    staleSnapshotFence: 'passed',
    externalProviders: 'not_exercised',
  };
}

function reminderMessage(conversationId: string, taskId: string, text: string) {
  return {
    conversationId,
    taskId,
    role: 'assistant' as const,
    origin: 'assistant' as const,
    text,
    parts: [{ type: 'text', text }],
  };
}
