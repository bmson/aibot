import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { dispatchOutbox } from '@assistant/core/workflow/dispatch';
import {
  FirestoreOutbox,
  FirestoreTaskRepository,
  type InstallationStore,
} from '@assistant/firestore';

/** Synthetic data only. Runs identically on the emulator and a newly provisioned test database. */
export async function firestoreTaskSmoke(store: InstallationStore) {
  const repo = new FirestoreTaskRepository(store);
  const request = {
    agentId: randomUUID(),
    type: 'adhoc',
    trust: 'owner',
    trigger: {},
    externalEventId: randomUUID(),
  };
  const creates = await Promise.all([repo.createTask(request), repo.createTask(request)]);
  assert.equal(creates.filter((result) => result.created).length, 1);
  const task = creates[0]?.task;
  assert.ok(task);
  await store.doc('rateLimits', 'task').set({ maxPerHour: 1, maxPerDay: 1 });
  const limited = await Promise.allSettled(
    Array.from({ length: 3 }, () =>
      repo.createTask({
        ...request,
        trust: 'unknown',
        externalEventId: randomUUID(),
      }),
    ),
  );
  assert.equal(limited.filter((result) => result.status === 'fulfilled').length, 1);
  for (const result of limited) {
    if (result.status === 'rejected') assert.equal(result.reason.name, 'TaskRateLimitError');
  }
  const lease = await repo.claim(task.id, 0);
  assert.ok(lease);
  assert.equal(
    await repo.sleepTask(lease, { phase: 'paused' }, new Date(Date.now() + 60_000)),
    true,
  );
  assert.equal(
    (await repo.findDueTasks(10)).some((row) => row.id === task.id),
    false,
  );
  await repo.wakeTask(task.id);
  assert.equal(await repo.claim(task.id, 0), null);
  const current = await repo.claim(task.id, 2);
  assert.ok(current);
  assert.equal(await repo.completeTask(lease, { status: 'done' }), false);
  await store.doc('tasks', task.id).update({ lockedUntil: new Date(0) });
  assert.equal(
    (await repo.findDueTasks(10)).some((row) => row.id === task.id),
    true,
  );
  assert.equal(await repo.completeTask(task.id, { status: 'cancelled' }), true);
  assert.equal(await repo.claim(task.id, 3), null);
  const deliveries: string[] = [];
  const report = await dispatchOutbox(new FirestoreOutbox(store), {
    enqueue: async (taskId, generation) => {
      deliveries.push(`${taskId}:${generation}`);
    },
  });
  assert.equal(report.retried + report.errors + report.leaseLost, 0);
  assert.ok(report.delivered > 0);
  assert.equal(new Set(deliveries).size, deliveries.length);
  return {
    taskCreation: 'passed',
    externalRateContention: 'passed',
    generationFencing: 'passed',
    sleepWakeRecovery: 'passed',
    cancellation: 'passed',
    outboxTransactions: 'passed',
    dispatch: report,
    cloudTasksTransport: 'not_exercised',
    runtimeServiceAccountIam: 'not_exercised',
  };
}
