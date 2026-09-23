/** Owner-scoped archive state changes for mobile Activity. */
export interface TaskActivityCommandRepository {
  readonly kind: 'task-activity-command-repository';
  archive(agentId: string, taskId: string): Promise<void>;
  restore(agentId: string, taskId: string): Promise<void>;
  revokeAutonomy(agentId: string, taskId: string): Promise<void>;
  raiseBudget(agentId: string, taskId: string, limit: number): Promise<void>;
  archiveOld(agentId: string, olderThanDays?: number): Promise<void>;
}
