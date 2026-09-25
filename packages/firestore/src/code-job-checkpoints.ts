import type { CodeJobLease, Records } from '@assistant/persistence';
import type { DocumentReference, DocumentSnapshot, Transaction } from '@google-cloud/firestore';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

/** Far above any job's step count; a longer list means a malformed checkpoint. */
const MAX_CHECKPOINT_KEYS = 200;

/**
 * Read a code job's lease inside a write transaction and refuse to commit
 * unless the task is still running under exactly this lease token. Renewals
 * rotate the token, so callers must pass the task's current token.
 */
export async function assertCodeJobLeaseInTransaction(
  tx: Transaction,
  store: InstallationStore,
  agentId: string,
  lease: CodeJobLease,
): Promise<void> {
  if (!lease.taskId || !lease.leaseToken) throw new Error('task lease lost');
  const snapshot = await tx.get(store.doc('tasks', lease.taskId));
  if (!snapshot.exists) throw new Error('task lease lost');
  const row = decodeRecord<Records['tasks']>(snapshot.data());
  if (
    row.id !== lease.taskId ||
    documentKey(row.id) !== snapshot.id ||
    row.agentId !== agentId ||
    row.status !== 'running' ||
    row.leaseToken !== lease.leaseToken ||
    !row.lockedUntil ||
    row.lockedUntil.getTime() <= store.now().getTime()
  )
    throw new Error('task lease lost');
}

/**
 * Per-task record of the steps a code job has committed. It is written in the
 * same transaction as each step's own writes, so a reclaimed task resumes
 * exactly after the last committed step.
 */
export function codeJobCheckpointRef(store: InstallationStore, taskId: string): DocumentReference {
  return store.doc('codeJobCheckpoints', taskId);
}

export function codeJobCheckpointKeys(
  snapshot: DocumentSnapshot,
  agentId: string,
  taskId: string,
): string[] {
  if (!snapshot.exists) return [];
  const keys = snapshot.get('keys');
  if (
    snapshot.get('agentId') !== agentId ||
    snapshot.get('taskId') !== taskId ||
    !Array.isArray(keys) ||
    keys.length > MAX_CHECKPOINT_KEYS ||
    keys.some((key) => typeof key !== 'string')
  )
    throw new Error('Code job checkpoint is malformed');
  return keys as string[];
}

/** Stage `key` as committed. Call only after every read of the transaction. */
export function recordCodeJobStep(
  tx: Transaction,
  store: InstallationStore,
  input: { agentId: string; taskId: string; job: string; keys: string[]; key: string; now: Date },
): void {
  if (input.keys.length >= MAX_CHECKPOINT_KEYS) throw new Error('Code job checkpoint is full');
  tx.set(codeJobCheckpointRef(store, input.taskId), {
    id: input.taskId,
    agentId: input.agentId,
    taskId: input.taskId,
    job: input.job,
    keys: [...input.keys, input.key],
    updatedAt: input.now,
  });
}

/** Committed step keys for a task, read outside a transaction to plan the run. */
export async function readCodeJobSteps(
  store: InstallationStore,
  agentId: string,
  taskId: string,
): Promise<string[]> {
  return codeJobCheckpointKeys(await codeJobCheckpointRef(store, taskId).get(), agentId, taskId);
}
