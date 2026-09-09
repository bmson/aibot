import { createHash, randomUUID } from 'node:crypto';
import {
  existingTaskResult,
  isExternalRoot,
  newTaskRecord,
  type Records,
  type TaskCreateInput,
  type TaskCreateResult,
  TaskRateLimitError,
} from '@assistant/persistence';
import { createWakeIntent } from './outbox.js';
import { decodeRecord, encodeRecord, type InstallationStore } from './store.js';

export async function createTask(
  store: InstallationStore,
  input: TaskCreateInput,
): Promise<TaskCreateResult> {
  const id = randomUUID();
  const eventRef = input.externalEventId
    ? store.doc('taskEventKeys', createHash('sha256').update(input.externalEventId).digest('hex'))
    : null;
  return store.db.runTransaction(async (tx) => {
    const guardRef = store.doc('coordination', 'external-task-enqueue');
    if (isExternalRoot(input)) await tx.get(guardRef);
    if (eventRef) {
      const key = await tx.get(eventRef);
      if (key.exists) {
        const existing = await tx.get(store.doc('tasks', String(key.get('taskId'))));
        if (!existing.exists) throw new Error('Task event index points to a missing task');
        return existingTaskResult(decodeRecord<Records['tasks']>(existing.data()), input);
      }
    }
    const now = store.now();
    if (isExternalRoot(input)) {
      const policy = await tx.get(store.doc('rateLimits', 'task'));
      // Installation bootstrap must explicitly supply a policy, even if caps are null.
      if (!policy.exists) throw new Error('Missing external task rate policy');
      for (const [cap, hours] of [
        [policy.get('maxPerHour'), 1],
        [policy.get('maxPerDay'), 24],
      ] as const) {
        if (cap === null) continue;
        if (!Number.isSafeInteger(cap) || cap < 0)
          throw new Error('Invalid external task rate policy');
        if (cap === 0) throw new TaskRateLimitError();
        const count = await tx.get(
          store
            .collection('tasks')
            .where('trust', 'in', ['known', 'unknown'])
            .where('parentTaskId', '==', null)
            .where('createdAt', '>=', new Date(now.getTime() - hours * 3_600_000))
            .limit(cap)
            .count(),
        );
        if (count.data().count >= cap) throw new TaskRateLimitError();
      }
    }
    const task = newTaskRecord(input, id, now);
    // All reads precede writes; retry callbacks contain no external side effects.
    if (isExternalRoot(input)) tx.set(guardRef, { lastTaskId: id, updatedAt: now });
    tx.create(store.doc('tasks', id), encodeRecord(task));
    if (eventRef) tx.create(eventRef, { taskId: id, createdAt: now });
    createWakeIntent(tx, store, { taskId: id, generation: 0, availableAt: task.runAfter ?? now });
    return { task, created: true };
  });
}
