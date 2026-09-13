import type { TaskLease, TaskLeaseRepository } from './contracts.js';
import type { Records } from './records.js';
import type { TaskCreateInput, TaskCreateResult } from './task-creation.js';
export interface TaskOutcome {
  status: 'done' | 'failed' | 'cancelled';
  progress?: string;
}
export interface TaskBudgetIncrease {
  agentId: string;
  limit: number;
}
export interface TaskWake {
  id: string;
  queueGeneration: number;
}
export interface TaskRepository extends TaskLeaseRepository {
  createTask(input: TaskCreateInput): Promise<TaskCreateResult>;
  /** Persist planner output only while the supplied running lease is current. */
  persistPlan(task: TaskLease, plan: unknown): Promise<boolean>;
  parkForApproval(
    task: TaskLease,
    state: Record<string, unknown>,
    pending: unknown[],
  ): Promise<boolean>;
  parkForBudget(task: TaskLease, state: Record<string, unknown>, resumeAt: Date): Promise<boolean>;
  sleepTask(task: TaskLease, state: Record<string, unknown>, runAfter: Date): Promise<boolean>;
  completeTask(task: TaskLease | string, outcome: TaskOutcome): Promise<boolean>;
  markTaskNeedsAttention(task: TaskLease, progress: string): Promise<boolean>;
  parkForEvent(task: TaskLease): Promise<boolean>;
  markAttentionNotified(taskId: string): Promise<boolean>;
  recordFailedAttempt(
    task: TaskLease,
    error: string,
  ): Promise<'retry' | 'dead_letter' | 'lost_lease'>;
  wakeTask(taskId: string, budgetIncrease?: TaskBudgetIncrease): Promise<TaskWake | null>;
  findDueTasks(limit?: number): Promise<Records['tasks'][]>;
}
