import type { Records } from './records.js';

type Task = Records['tasks'];
export type TaskCreateInput = Pick<Task, 'agentId' | 'type' | 'trust' | 'trigger'> &
  Partial<
    Pick<
      Task,
      | 'conversationId'
      | 'goalId'
      | 'title'
      | 'externalEventId'
      | 'parentTaskId'
      | 'runAfter'
      | 'deadline'
      | 'maxSteps'
      | 'budgetUsdLimit'
      | 'plan'
      | 'autonomyGrant'
    >
  >;
export interface TaskCreateResult {
  task: Task;
  created: boolean;
}

export class TaskRateLimitError extends Error {
  constructor() {
    super('externally-triggered task rate limit exceeded');
    this.name = 'TaskRateLimitError';
  }
}

export function isExternalRoot(input: TaskCreateInput): boolean {
  return ['known', 'unknown'].includes(input.trust) && !input.parentTaskId;
}

/** Existing event IDs are installation-wide; never return another owner's task. */
export function existingTaskResult(task: Task, input: TaskCreateInput): TaskCreateResult {
  if (task.agentId !== input.agentId) throw new Error('Task event belongs to another agent');
  return { task, created: false };
}

/** Explicit defaults keep the Firestore record compatible with PostgreSQL/API rows. */
export function newTaskRecord(input: TaskCreateInput, id: string, now: Date): Task {
  const budget = Number(input.budgetUsdLimit || '0.50');
  if (!input.agentId || !input.type || !Number.isFinite(budget) || budget < 0 || budget >= 10_000)
    throw new Error('Invalid task creation input');
  const budgetUsdLimit = budget.toFixed(4);
  if (Number(budgetUsdLimit) >= 10_000) throw new Error('Task budget exceeds database precision');
  const maxSteps = input.maxSteps ?? 12;
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 2_147_483_647)
    throw new Error('Invalid task step limit');
  for (const date of [now, input.runAfter, input.deadline]) {
    if (date && !Number.isFinite(date.getTime())) throw new Error('Invalid task time');
  }
  if (
    !['owner', 'known', 'unknown', 'assistant'].includes(input.trust) ||
    ![
      'chat_turn',
      'sms_turn',
      'email_triage',
      'scheduled',
      'mission',
      'browser_job',
      'adhoc',
    ].includes(input.type)
  )
    throw new Error('Invalid task type or trust');
  return {
    id,
    agentId: input.agentId,
    type: input.type,
    trust: input.trust,
    trigger: input.trigger,
    title: input.title ?? null,
    status: input.runAfter ? 'sleeping' : 'pending',
    conversationId: input.conversationId ?? null,
    goalId: input.goalId ?? null,
    parentTaskId: input.parentTaskId ?? null,
    externalEventId: input.externalEventId || null,
    runAfter: input.runAfter ?? null,
    deadline: input.deadline ?? null,
    maxSteps,
    budgetUsdLimit,
    spentUsd: '0.000000',
    plan: input.plan ?? null,
    autonomyGrant: input.autonomyGrant ?? null,
    state: {},
    progress: '',
    nextAction: '',
    progressPercent: null,
    archivedAt: null,
    reflectEvery: null,
    lastReflectedAt: null,
    lockedUntil: null,
    leaseToken: null,
    queueGeneration: 0,
    attempt: 0,
    reclaimCount: 0,
    attentionNotifiedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}
