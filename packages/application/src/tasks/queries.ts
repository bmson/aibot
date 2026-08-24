import { getAgent } from '@assistant/core/chat';
import { type AutonomyGrant, activeAutonomyGrant } from '@assistant/core/workflow/autonomy';
import { approvals, type Db, files, messages, modelCalls, tasks, toolCalls } from '@assistant/db';
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';

export const terminalTaskStatuses = ['done', 'failed', 'cancelled'] as const;
export type ActivityFilter = 'all' | 'needs-you' | 'working' | 'scheduled' | 'completed';

function statusesForFilter(filter: ActivityFilter): string[] | undefined {
  if (filter === 'needs-you') return ['waiting_approval', 'waiting_budget', 'needs_attention'];
  if (filter === 'working') return ['pending', 'running'];
  if (filter === 'scheduled') return ['sleeping', 'waiting_event'];
  if (filter === 'completed') return [...terminalTaskStatuses];
  return undefined;
}

export interface ActivityItem {
  id: string;
  type: string;
  status: string;
  title: string | null;
  progress: string;
  trust: string;
  spentUsd: string;
  budgetUsdLimit: string;
  updatedAt: Date;
  archivedAt: Date | null;
  hasPendingApproval: boolean;
  hasActiveAutonomy: boolean;
  stuckWaiting: boolean;
}

export interface ActivityList {
  items: ActivityItem[];
  archivedCount: number;
}

/** Load the Activity list without exposing task or approval tables to the UI. */
export async function listActivity(
  db: Db,
  input: { archived: boolean; filter: ActivityFilter; limit?: number },
): Promise<ActivityList> {
  const agent = await getAgent(db);
  const statuses = statusesForFilter(input.filter);
  const [rows, archivedCountRows] = await Promise.all([
    db
      .select({
        id: tasks.id,
        type: tasks.type,
        status: tasks.status,
        title: tasks.title,
        progress: tasks.progress,
        trust: tasks.trust,
        spentUsd: tasks.spentUsd,
        budgetUsdLimit: tasks.budgetUsdLimit,
        updatedAt: tasks.updatedAt,
        archivedAt: tasks.archivedAt,
        autonomyGrant: tasks.autonomyGrant,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.agentId, agent.id),
          sql`${tasks.trigger}->'payload'->>'canary' IS DISTINCT FROM 'true'`,
          input.archived ? isNotNull(tasks.archivedAt) : isNull(tasks.archivedAt),
          statuses ? inArray(tasks.status, statuses) : undefined,
        ),
      )
      .orderBy(desc(tasks.updatedAt))
      .limit(input.limit ?? 50),
    db
      .select({ value: count() })
      .from(tasks)
      .where(and(eq(tasks.agentId, agent.id), isNotNull(tasks.archivedAt))),
  ]);

  const waitingIds = rows
    .filter((task) => task.status === 'waiting_approval')
    .map((task) => task.id);
  const pendingIds =
    waitingIds.length === 0
      ? []
      : await db
          .selectDistinct({ taskId: approvals.taskId })
          .from(approvals)
          .where(and(inArray(approvals.taskId, waitingIds), eq(approvals.status, 'pending')));
  const pendingApprovalTaskIds = new Set(pendingIds.map((row) => row.taskId));

  return {
    items: rows.map(({ autonomyGrant, ...task }) => ({
      ...task,
      hasPendingApproval: pendingApprovalTaskIds.has(task.id),
      hasActiveAutonomy: activeAutonomyGrant({ ...task, autonomyGrant }, Date.now()) !== null,
      stuckWaiting: task.status === 'waiting_approval' && !pendingApprovalTaskIds.has(task.id),
    })),
    archivedCount: Number(archivedCountRows[0]?.value ?? 0),
  };
}

export interface TaskSnapshot {
  id: string;
  type: string;
  status: string;
  title: string | null;
  trust: string;
  spentUsd: string;
  budgetUsdLimit: string;
  updatedAt: Date;
  deadline: Date | null;
  nextAction: string;
  progress: string;
  progressPercent: number | null;
  plan: unknown;
  archivedAt: Date | null;
}

export interface TaskToolCall {
  id: string;
  createdAt: Date;
  finishedAt: Date | null;
  toolName: string;
  step: number;
  status: string;
  decision: unknown;
  args: unknown;
  result: unknown;
  error: string | null;
}

export interface TaskModelCall {
  id: string;
  createdAt: Date;
  role: string;
  model: string;
  costUsd: string;
  latencyMs: number | null;
}

export interface TaskApproval {
  id: string;
  requestedAt: Date;
  status: string;
  summary: string;
  shortCode: string;
  resolvedVia: string | null;
  resolvedAt: Date | null;
}

export interface TaskMessage {
  id: string;
  createdAt: Date;
  role: string;
  text: string;
}

export interface TaskFile {
  id: string;
  workspacePath: string;
  bytes: number;
}

export interface TaskDetail {
  timezone: string;
  task: TaskSnapshot;
  toolCalls: TaskToolCall[];
  modelCalls: TaskModelCall[];
  approvals: TaskApproval[];
  messages: TaskMessage[];
  files: TaskFile[];
  activeGrant: AutonomyGrant | null;
  stuckWaiting: boolean;
}

/** Load the full owner-visible audit record for one task. */
export async function getTaskDetail(db: Db, taskId: string): Promise<TaskDetail | null> {
  const agent = await getAgent(db);
  const [task] = await db
    .select({
      id: tasks.id,
      type: tasks.type,
      status: tasks.status,
      title: tasks.title,
      trust: tasks.trust,
      spentUsd: tasks.spentUsd,
      budgetUsdLimit: tasks.budgetUsdLimit,
      updatedAt: tasks.updatedAt,
      deadline: tasks.deadline,
      nextAction: tasks.nextAction,
      progress: tasks.progress,
      progressPercent: tasks.progressPercent,
      plan: tasks.plan,
      archivedAt: tasks.archivedAt,
      autonomyGrant: tasks.autonomyGrant,
    })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.agentId, agent.id)));
  if (!task) return null;

  const [taskToolCalls, taskModelCalls, taskApprovals, taskMessages, taskFiles] = await Promise.all(
    [
      db
        .select({
          id: toolCalls.id,
          createdAt: toolCalls.createdAt,
          finishedAt: toolCalls.finishedAt,
          toolName: toolCalls.toolName,
          step: toolCalls.step,
          status: toolCalls.status,
          decision: toolCalls.decision,
          args: toolCalls.args,
          result: toolCalls.result,
          error: toolCalls.error,
        })
        .from(toolCalls)
        .where(eq(toolCalls.taskId, taskId))
        .orderBy(asc(toolCalls.createdAt)),
      db
        .select({
          id: modelCalls.id,
          createdAt: modelCalls.createdAt,
          role: modelCalls.role,
          model: modelCalls.model,
          costUsd: modelCalls.costUsd,
          latencyMs: modelCalls.latencyMs,
        })
        .from(modelCalls)
        .where(eq(modelCalls.taskId, taskId))
        .orderBy(asc(modelCalls.createdAt)),
      db
        .select({
          id: approvals.id,
          requestedAt: approvals.requestedAt,
          status: approvals.status,
          summary: approvals.summary,
          shortCode: approvals.shortCode,
          resolvedVia: approvals.resolvedVia,
          resolvedAt: approvals.resolvedAt,
        })
        .from(approvals)
        .where(eq(approvals.taskId, taskId))
        .orderBy(asc(approvals.requestedAt)),
      db
        .select({
          id: messages.id,
          createdAt: messages.createdAt,
          role: messages.role,
          text: messages.text,
        })
        .from(messages)
        .where(eq(messages.taskId, taskId))
        .orderBy(asc(messages.createdAt)),
      db
        .select({ id: files.id, workspacePath: files.workspacePath, bytes: files.bytes })
        .from(files)
        .where(eq(files.taskId, taskId))
        .orderBy(asc(files.createdAt)),
    ],
  );

  const { autonomyGrant, ...snapshot } = task;
  return {
    timezone: agent.timezone,
    task: snapshot,
    toolCalls: taskToolCalls,
    modelCalls: taskModelCalls,
    approvals: taskApprovals,
    messages: taskMessages,
    files: taskFiles,
    activeGrant: activeAutonomyGrant(task, Date.now()),
    stuckWaiting:
      task.status === 'waiting_approval' &&
      !taskApprovals.some((approval) => approval.status === 'pending'),
  };
}
