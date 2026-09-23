import type { Records } from './records.js';

export type ActivityTaskRecord = Pick<
  Records['tasks'],
  | 'id'
  | 'agentId'
  | 'type'
  | 'status'
  | 'title'
  | 'progress'
  | 'trust'
  | 'spentUsd'
  | 'budgetUsdLimit'
  | 'updatedAt'
  | 'archivedAt'
  | 'autonomyGrant'
  | 'trigger'
>;

export interface TaskActivityRepository {
  readonly kind: 'task-activity-repository';
  list(
    agentId: string,
    input: { archived: boolean; statuses?: string[]; limit: number },
  ): Promise<{
    tasks: ActivityTaskRecord[];
    archivedCount: number;
    pendingApprovalTaskIds: string[];
  }>;
}

export interface TaskActivityDetail {
  timezone: string;
  task: Pick<
    Records['tasks'],
    | 'id'
    | 'type'
    | 'status'
    | 'title'
    | 'trust'
    | 'spentUsd'
    | 'budgetUsdLimit'
    | 'updatedAt'
    | 'deadline'
    | 'nextAction'
    | 'progress'
    | 'progressPercent'
    | 'plan'
    | 'state'
    | 'archivedAt'
    | 'autonomyGrant'
  >;
  toolCalls: Array<
    Pick<
      Records['toolCalls'],
      | 'id'
      | 'createdAt'
      | 'finishedAt'
      | 'toolName'
      | 'step'
      | 'status'
      | 'decision'
      | 'args'
      | 'result'
      | 'error'
    >
  >;
  modelCalls: Array<
    Pick<Records['modelCalls'], 'id' | 'createdAt' | 'role' | 'model' | 'costUsd' | 'latencyMs'>
  >;
  approvals: Array<
    Pick<
      Records['approvals'],
      'id' | 'requestedAt' | 'status' | 'summary' | 'shortCode' | 'resolvedVia' | 'resolvedAt'
    >
  >;
  messages: Array<Pick<Records['messages'], 'id' | 'createdAt' | 'role' | 'text'>>;
  files: Array<Pick<Records['files'], 'id' | 'workspacePath' | 'bytes'>>;
  actions: Array<
    Pick<
      Records['toolCalls'],
      'id' | 'createdAt' | 'finishedAt' | 'toolName' | 'status' | 'result' | 'error'
    >
  >;
  hasPendingApproval: boolean;
}

/** Owner-scoped bounded task detail read, including only fields rendered by Activity. */
export interface TaskActivityDetailRepository {
  getDetail(
    agentId: string,
    taskId: string,
    input: { pageSize: number; before?: Date },
  ): Promise<TaskActivityDetail | null>;
}
