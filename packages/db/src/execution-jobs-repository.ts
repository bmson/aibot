import type {
  ExecutionJobInput,
  ExecutionJobRepository,
  ExecutionJobSettleResult,
  TaskLease,
} from '@assistant/persistence';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { approvals, tasks, toolCalls } from './schema.js';
import { activeLease } from './task-lease-repository.js';

const PENDING_KINDS = new Set(['browser_job_pending', 'code_job_pending', 'document_job_pending']);
const SHA256_HEX = /^[0-9a-f]{64}$/;

function isPendingSentinel(result: unknown): boolean {
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

function leaseScope(lease: TaskLease) {
  return and(activeLease(lease), eq(tasks.agentId, lease.agentId));
}

function assertInputLease(input: ExecutionJobInput, lease: TaskLease): void {
  if (input.taskId !== lease.id) throw new Error('execution job task does not match lease');
  if (!isPendingSentinel(input.pending)) throw new Error('execution job sentinel is invalid');
}

function validTimeout(timeoutAt: Date): void {
  if (!(timeoutAt instanceof Date) || !Number.isFinite(timeoutAt.getTime()))
    throw new Error('execution job timeout is invalid');
}

export function createPostgresExecutionJobRepository(db: Db): ExecutionJobRepository {
  return {
    kind: 'execution-job-repository',
    async loadToolCall(agentId, taskId, toolCallId) {
      const [row] = await db
        .select({ toolCall: toolCalls })
        .from(toolCalls)
        .innerJoin(tasks, eq(toolCalls.taskId, tasks.id))
        .where(
          and(
            eq(toolCalls.id, toolCallId),
            eq(toolCalls.taskId, taskId),
            eq(tasks.agentId, agentId),
          ),
        )
        .limit(1);
      return row?.toolCall ?? null;
    },
    async listPendingApprovals(agentId, taskId, approvalIds) {
      if (approvalIds.length === 0) return [];
      return db
        .select({ approval: approvals })
        .from(approvals)
        .innerJoin(tasks, eq(approvals.taskId, tasks.id))
        .where(
          and(
            eq(approvals.taskId, taskId),
            eq(tasks.agentId, agentId),
            inArray(approvals.id, approvalIds),
          ),
        )
        .then((rows) => rows.map((row) => row.approval));
    },
    async stage(input, lease) {
      assertInputLease(input, lease);
      await db.transaction(async (tx) => {
        const [task] = await tx
          .select({ id: tasks.id })
          .from(tasks)
          .where(leaseScope(lease))
          .for('update');
        if (!task) throw new Error('task lease lost while staging execution job');
        const [updated] = await tx
          .update(toolCalls)
          .set({ result: input.pending })
          .where(
            and(
              eq(toolCalls.id, input.toolCallId),
              eq(toolCalls.taskId, input.taskId),
              eq(toolCalls.status, 'executing'),
              or(isNull(toolCalls.result), eq(toolCalls.result, input.pending)),
            ),
          )
          .returning({ id: toolCalls.id });
        if (!updated) throw new Error('execution tool call cannot be staged');
        const [checkpointed] = await tx
          .update(tasks)
          .set({
            state: input.checkpointState,
            attempt: 0,
            reclaimCount: 0,
            updatedAt: sql`now()`,
          })
          .where(leaseScope(lease))
          .returning({ id: tasks.id });
        if (!checkpointed) throw new Error('task lease lost while checkpointing execution job');
      });
    },
    async clear(input, lease) {
      assertInputLease(input, lease);
      await db.transaction(async (tx) => {
        const [task] = await tx
          .select({ id: tasks.id })
          .from(tasks)
          .where(leaseScope(lease))
          .for('update');
        if (!task) throw new Error('task lease lost while clearing execution job');
        const [updated] = await tx
          .update(toolCalls)
          .set({ result: null })
          .where(
            and(
              eq(toolCalls.id, input.toolCallId),
              eq(toolCalls.taskId, input.taskId),
              eq(toolCalls.status, 'executing'),
              eq(toolCalls.result, input.pending),
            ),
          )
          .returning({ id: toolCalls.id });
        if (!updated) throw new Error('execution tool call cannot be cleared');
        const [checkpointed] = await tx
          .update(tasks)
          .set({
            state: input.checkpointState,
            attempt: 0,
            reclaimCount: 0,
            updatedAt: sql`now()`,
          })
          .where(leaseScope(lease))
          .returning({ id: tasks.id });
        if (!checkpointed) throw new Error('task lease lost while checkpointing cleared job');
      });
    },
    async settle(input, lease) {
      if (input.taskId !== lease.id) return { kind: 'stale' };
      validTimeout(input.timeoutAt);
      return db.transaction(async (tx) => {
        const [task] = await tx
          .select({ id: tasks.id })
          .from(tasks)
          .where(leaseScope(lease))
          .for('update');
        if (!task) return { kind: 'stale' };
        const [selected] = await tx
          .select({
            toolCall: toolCalls,
            timedOut: sql<boolean>`clock_timestamp() >= ${input.timeoutAt.toISOString()}::timestamptz`,
          })
          .from(toolCalls)
          .where(and(eq(toolCalls.id, input.toolCallId), eq(toolCalls.taskId, input.taskId)));
        if (!selected) return { kind: 'stale' };
        const row = selected.toolCall;
        if (!isPendingSentinel(row.result))
          return {
            kind: 'result',
            id: row.id,
            result: row.result,
            startedAt: row.startedAt,
            decision: row.decision,
          };
        if (row.status !== 'executing' && row.status !== 'succeeded') return { kind: 'stale' };
        if (!selected.timedOut) return { kind: 'still_pending' };
        const failure = {
          ok: false as const,
          error:
            'the background job never reported back (timed out) — treat this attempt as failed',
        };
        await tx
          .update(toolCalls)
          .set({ status: 'failed', result: failure, error: failure.error, finishedAt: sql`now()` })
          .where(
            and(
              eq(toolCalls.id, row.id),
              eq(toolCalls.taskId, input.taskId),
              inArray(toolCalls.status, ['executing', 'succeeded']),
              eq(toolCalls.result, row.result),
            ),
          );
        return {
          kind: 'timeout',
          id: row.id,
          failure,
          startedAt: row.startedAt,
          decision: row.decision,
        };
      }) as Promise<ExecutionJobSettleResult>;
    },
  };
}
