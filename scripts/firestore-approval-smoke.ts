import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  expireStaleApprovals,
  resumeResolvedApprovalTasks,
} from '@assistant/core/workflow/approvals';
import {
  FirestoreApprovalRepository,
  FirestoreTaskRepository,
  type InstallationStore,
} from '@assistant/firestore';

/** Exercise the portable sweeps through a real task claim/park/recovery lifecycle. */
export async function firestoreApprovalSmoke(store: InstallationStore) {
  const repository = new FirestoreApprovalRepository(store);
  const tasks = new FirestoreTaskRepository(store);
  const now = new Date();
  const agentId = randomUUID();
  async function fixture() {
    const { task } = await tasks.createTask({
      agentId,
      type: 'scheduled',
      trust: 'assistant',
      trigger: { source: 'schedule', payload: {} },
    });
    const lease = await tasks.claim(task.id, task.queueGeneration);
    assert.ok(lease);
    const approvalId = randomUUID();
    const toolCallId = randomUUID();
    await store.doc('toolCalls', toolCallId).set({
      id: toolCallId,
      taskId: task.id,
      toolName: 'synthetic.action',
      status: 'awaiting_approval',
    });
    await store.doc('approvals', approvalId).set({
      id: approvalId,
      taskId: task.id,
      toolCallId,
      status: 'pending',
      requestedAt: new Date(now.getTime() - 60_000),
      expiresAt: new Date(now.getTime() - 1_000),
      shortCode: randomUUID(),
    });
    return { task, lease, approvalId, toolCallId };
  }

  const expired = await fixture();
  assert.equal(
    await tasks.parkForApproval(expired.lease, { phase: 'execute' }, [
      { approvalId: expired.approvalId, toolCallId: expired.toolCallId },
    ]),
    true,
  );
  const races = await Promise.all([
    expireStaleApprovals(repository, 200, now),
    expireStaleApprovals(repository, 200, now),
  ]);
  assert.equal(races.flat().filter((id) => id === expired.task.id).length, 1);
  assert.equal((await store.doc('approvals', expired.approvalId).get()).get('status'), 'expired');
  assert.equal((await store.doc('toolCalls', expired.toolCallId).get()).get('status'), 'denied');
  assert.equal((await store.doc('tasks', expired.task.id).get()).get('queueGeneration'), 1);
  assert.equal(await tasks.claim(expired.task.id, 0), null);
  assert.ok(await tasks.claim(expired.task.id, 1));

  // Decision arrives while the executor is still running, before it parks.
  const stranded = await fixture();
  assert.equal(
    (
      await repository.resolve({
        approvalId: stranded.approvalId,
        decision: 'approved',
        via: 'web',
      })
    ).ok,
    true,
  );
  assert.equal(
    await tasks.parkForApproval(stranded.lease, { phase: 'execute' }, [
      { approvalId: stranded.approvalId, toolCallId: stranded.toolCallId },
    ]),
    true,
  );
  const recovery = await Promise.all([
    resumeResolvedApprovalTasks(repository, 200, now),
    resumeResolvedApprovalTasks(repository, 200, now),
  ]);
  assert.equal(recovery.flat().filter((id) => id === stranded.task.id).length, 1);
  assert.equal((await store.doc('tasks', stranded.task.id).get()).get('queueGeneration'), 1);
  assert.ok(await tasks.claim(stranded.task.id, 1));
  const intents = await store.collection('outbox').get();
  for (const taskId of [expired.task.id, stranded.task.id])
    assert.equal(
      intents.docs.filter((doc) => doc.get('taskId') === taskId && doc.get('generation') === 1)
        .length,
      1,
    );
  return {
    approvalExpiry: 'passed',
    preParkRecovery: 'passed',
    generationFences: 'passed',
    durableWakeIntents: 'passed',
    externalProviders: 'not_exercised',
  };
}
