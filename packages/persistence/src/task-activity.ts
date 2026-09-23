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
