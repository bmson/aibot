import { isDeepStrictEqual } from 'node:util';
import type {
  ExecutionJobInput,
  ExecutionJobRepository,
  ExecutionJobSettleResult,
  Records,
  TaskLease,
} from '@assistant/persistence';
import { decodeRecord, encodeRecord, type InstallationStore } from './store.js';

const PENDING_KINDS = new Set(['browser_job_pending', 'code_job_pending', 'document_job_pending']);
const SHA256_HEX = /^[0-9a-f]{64}$/;

function live(row: Records['tasks'], lease: TaskLease, now: Date) {
  return (
    row.id === lease.id &&
    row.agentId === lease.agentId &&
    row.status === 'running' &&
    typeof lease.leaseToken === 'string' &&
    lease.leaseToken.length > 0 &&
    row.leaseToken === lease.leaseToken &&
    row.lockedUntil instanceof Date &&
    Number.isFinite(row.lockedUntil.getTime()) &&
    row.lockedUntil.getTime() > now.getTime()
  );
}
function pending(result: unknown): boolean {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const value = result as { pending?: unknown; callbackToken?: unknown; timeoutAt?: unknown };
  return (
    typeof value.pending === 'string' &&
    PENDING_KINDS.has(value.pending) &&
    typeof value.callbackToken === 'string' &&
    SHA256_HEX.test(value.callbackToken) &&
    typeof value.timeoutAt === 'string'
  );
}

function assertInputLease(input: ExecutionJobInput, lease: TaskLease): void {
  if (input.taskId !== lease.id) throw new Error('execution job task does not match lease');
  if (!pending(input.pending)) throw new Error('execution job sentinel is invalid');
}

function validTimeout(timeoutAt: Date): void {
  if (!(timeoutAt instanceof Date) || !Number.isFinite(timeoutAt.getTime()))
    throw new Error('execution job timeout is invalid');
}

export class FirestoreExecutionJobRepository implements ExecutionJobRepository {
  readonly kind = 'execution-job-repository' as const;
  constructor(readonly store: InstallationStore) {}

  async loadToolCall(agentId: string, taskId: string, toolCallId: string) {
    const snapshots = await this.store.db.getAll(
      this.store.doc('tasks', taskId),
      this.store.doc('toolCalls', toolCallId),
    );
    const taskSnapshot = snapshots[0];
    const toolSnapshot = snapshots[1];
    if (!taskSnapshot?.exists || !toolSnapshot?.exists) return null;
    const task = decodeRecord<Records['tasks']>(taskSnapshot.data());
    const tool = decodeRecord<Records['toolCalls']>(toolSnapshot.data());
    return task.id === taskId &&
      task.agentId === agentId &&
      tool.id === toolCallId &&
      tool.taskId === taskId
      ? tool
      : null;
  }

  async listPendingApprovals(agentId: string, taskId: string, approvalIds: string[]) {
    if (approvalIds.length === 0) return [];
    const uniqueIds = [...new Set(approvalIds)];
    const snapshots = await this.store.db.getAll(
      this.store.doc('tasks', taskId),
      ...uniqueIds.map((id) => this.store.doc('approvals', id)),
    );
    const taskSnapshot = snapshots[0];
    if (!taskSnapshot?.exists) return [];
    const task = decodeRecord<Records['tasks']>(taskSnapshot.data());
    if (task.id !== taskId || task.agentId !== agentId) return [];
    return snapshots.slice(1).flatMap((snapshot, index) => {
      if (!snapshot?.exists) return [];
      const approval = decodeRecord<Records['approvals']>(snapshot.data());
      return approval.id === uniqueIds[index] && approval.taskId === taskId ? [approval] : [];
    });
  }

  async stage(input: ExecutionJobInput, lease: TaskLease) {
    assertInputLease(input, lease);
    await this.store.db.runTransaction(async (tx) => {
      const taskRef = this.store.doc('tasks', lease.id);
      const toolRef = this.store.doc('toolCalls', input.toolCallId);
      const snapshots = await tx.getAll(taskRef, toolRef);
      const task = snapshots[0];
      const tool = snapshots[1];
      const now = this.store.now();
      if (!task?.exists || !live(decodeRecord<Records['tasks']>(task.data()), lease, now))
        throw new Error('task lease lost while staging execution job');
      if (!tool?.exists) throw new Error('execution tool call cannot be staged');
      const toolRow = decodeRecord<Records['toolCalls']>(tool.data());
      if (
        toolRow.id !== input.toolCallId ||
        toolRow.taskId !== input.taskId ||
        toolRow.status !== 'executing' ||
        (toolRow.result !== null && !isDeepStrictEqual(toolRow.result, input.pending))
      )
        throw new Error('execution tool call cannot be staged');
      tx.update(toolRef, encodeRecord({ result: input.pending }));
      tx.update(
        taskRef,
        encodeRecord({
          state: input.checkpointState,
          attempt: 0,
          reclaimCount: 0,
          updatedAt: now,
        }),
      );
    });
  }
  async clear(input: ExecutionJobInput, lease: TaskLease) {
    assertInputLease(input, lease);
    await this.store.db.runTransaction(async (tx) => {
      const taskRef = this.store.doc('tasks', lease.id);
      const toolRef = this.store.doc('toolCalls', input.toolCallId);
      const snapshots = await tx.getAll(taskRef, toolRef);
      const task = snapshots[0];
      const tool = snapshots[1];
      const now = this.store.now();
      if (!task?.exists || !live(decodeRecord<Records['tasks']>(task.data()), lease, now))
        throw new Error('task lease lost while clearing execution job');
      if (!tool?.exists) throw new Error('execution tool call cannot be cleared');
      const toolRow = decodeRecord<Records['toolCalls']>(tool.data());
      if (
        toolRow.id !== input.toolCallId ||
        toolRow.taskId !== input.taskId ||
        toolRow.status !== 'executing' ||
        !isDeepStrictEqual(toolRow.result, input.pending)
      )
        throw new Error('execution tool call cannot be cleared');
      tx.update(toolRef, { result: null });
      tx.update(
        taskRef,
        encodeRecord({
          state: input.checkpointState,
          attempt: 0,
          reclaimCount: 0,
          updatedAt: now,
        }),
      );
    });
  }
  async settle(
    input: { taskId: string; toolCallId: string; timeoutAt: Date },
    lease: TaskLease,
  ): Promise<ExecutionJobSettleResult> {
    if (input.taskId !== lease.id) return { kind: 'stale' };
    validTimeout(input.timeoutAt);
    return this.store.db.runTransaction(async (tx) => {
      const taskRef = this.store.doc('tasks', lease.id);
      const toolRef = this.store.doc('toolCalls', input.toolCallId);
      const snapshots = await tx.getAll(taskRef, toolRef);
      const task = snapshots[0];
      const tool = snapshots[1];
      const now = this.store.now();
      if (
        !task?.exists ||
        !tool?.exists ||
        !live(decodeRecord<Records['tasks']>(task.data()), lease, now)
      )
        return { kind: 'stale' };
      const toolRow = decodeRecord<Records['toolCalls']>(tool.data());
      if (toolRow.id !== input.toolCallId || toolRow.taskId !== input.taskId)
        return { kind: 'stale' };
      const result = toolRow.result;
      if (!pending(result))
        return {
          kind: 'result',
          id: input.toolCallId,
          result,
          startedAt: (toolRow.startedAt as Date | null) ?? null,
          decision: toolRow.decision,
        };
      if (toolRow.status !== 'executing' && toolRow.status !== 'succeeded')
        return { kind: 'stale' };
      if (now.getTime() < input.timeoutAt.getTime()) return { kind: 'still_pending' };
      const failure = {
        ok: false as const,
        error: 'the background job never reported back (timed out) — treat this attempt as failed',
      };
      tx.update(
        toolRef,
        encodeRecord({
          status: 'failed',
          result: failure,
          error: failure.error,
          finishedAt: now,
        }),
      );
      return {
        kind: 'timeout',
        id: input.toolCallId,
        failure,
        startedAt: (toolRow.startedAt as Date | null) ?? null,
        decision: toolRow.decision,
      };
    });
  }
}
