import type { TaskLease } from './contracts.js';
import type { Records } from './records.js';

export interface ExecutionJobInput {
  taskId: string;
  toolCallId: string;
  pending: unknown;
  checkpointState: unknown;
}

export type ExecutionJobSettleResult =
  | { kind: 'result'; result: unknown; id: string; startedAt: Date | null; decision: unknown }
  | {
      kind: 'timeout';
      failure: { ok: false; error: string };
      id: string;
      startedAt: Date | null;
      decision: unknown;
    }
  | { kind: 'still_pending' }
  | { kind: 'stale' };

export interface ExecutionJobRepository {
  readonly kind: 'execution-job-repository';
  loadToolCall(
    agentId: string,
    taskId: string,
    toolCallId: string,
  ): Promise<Records['toolCalls'] | null>;
  listPendingApprovals(
    agentId: string,
    taskId: string,
    approvalIds: string[],
  ): Promise<Records['approvals'][]>;
  stage(input: ExecutionJobInput, lease: TaskLease): Promise<void>;
  clear(input: ExecutionJobInput, lease: TaskLease): Promise<void>;
  settle(
    input: { taskId: string; toolCallId: string; timeoutAt: Date },
    lease: TaskLease,
  ): Promise<ExecutionJobSettleResult>;
}
