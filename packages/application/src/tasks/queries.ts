import { getAgent } from '@assistant/core/chat';
import { type AutonomyGrant, activeAutonomyGrant } from '@assistant/core/workflow/autonomy';
import { approvals, type Db, files, messages, modelCalls, tasks, toolCalls } from '@assistant/db';
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

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
  plan: RecordedValue | null;
  archivedAt: Date | null;
}

/**
 * One JSON value out of the audit record, already rendered and already clipped.
 *
 * Tool results are persisted at whatever size the tool returned — a fetched
 * page, a workspace read, a browser step budgeted to 400KB — and the task
 * record used to hand every one of them to the page in full. A long mission
 * therefore rendered megabytes of collapsed `<details>`, all of it in the RSC
 * payload and the DOM whether or not anyone opened it. Serializing and
 * clipping here is what makes the page's weight a function of the page size
 * instead of a function of what the tools happened to return.
 */
export interface RecordedValue {
  /** Pretty-printed JSON (or the raw string), clipped to the budget. */
  text: string;
  /** Set when `text` is only the start of the value. */
  truncated: boolean;
  /** The full rendered length, so the page can say what is not being shown. */
  totalChars: number;
}

/** How much of one recorded value travels with a timeline entry. */
const MAX_RECORDED_CHARS = 4_000;
/** The same, for the action summary, which carries every call in the task. */
const MAX_PREVIEW_CHARS = 600;
/** How many timeline entries one page of the task record carries. */
export const TASK_TIMELINE_PAGE_SIZE = 100;
/** Owner-visible message text on the timeline is a one-line reminder, not the body. */
const MAX_TIMELINE_MESSAGE_CHARS = 200;

function record(value: unknown, budget: number): RecordedValue | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? 'null');
  return text.length <= budget
    ? { text, truncated: false, totalChars: text.length }
    : { text: text.slice(0, budget), truncated: true, totalChars: text.length };
}

/**
 * Whether a tool call actually did what it was asked.
 *
 * A `succeeded` status only means the adapter returned without throwing; a
 * provider can still answer "no" inside the payload. This is a rule about the
 * work, not about how it is displayed, so it lives here rather than in the
 * page that used to own it.
 */
function completedSuccessfully(status: string, result: unknown): boolean {
  if (status !== 'succeeded') return false;
  if (!result || typeof result !== 'object') return true;
  const payload = result as { ok?: unknown; status?: unknown; deliveryStatus?: unknown };
  return (
    payload.ok !== false &&
    !(typeof payload.status === 'number' && payload.status >= 400) &&
    payload.deliveryStatus !== 'unknown'
  );
}

export interface TaskToolCall {
  id: string;
  createdAt: Date;
  finishedAt: Date | null;
  toolName: string;
  step: number;
  status: string;
  /** Pulled out of the decision JSON so the rest of it never travels. */
  riskTier: string | null;
  policyId: string | null;
  args: RecordedValue | null;
  result: RecordedValue | null;
  error: RecordedValue | null;
}

/**
 * One tool call as the "what actually happened" summary sees it. That section
 * reads the WHOLE task rather than the visible page, so this shape carries no
 * full payloads — only a preview, bounded per call.
 */
export interface TaskAction {
  id: string;
  toolName: string;
  createdAt: Date;
  finishedAt: Date | null;
  completed: boolean;
  error: string | null;
  resultPreview: RecordedValue | null;
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
  /** Every tool call in the task, summarized — not just the visible page. */
  actions: TaskAction[];
  /** Older entries exist behind the oldest one on this page. */
  hasMoreTimeline: boolean;
  activeGrant: AutonomyGrant | null;
  stuckWaiting: boolean;
}

/**
 * Load one page of the owner-visible audit record for a task.
 *
 * The timeline is four independent streams merged by time, so a page is taken
 * by fetching the newest `pageSize` of each and keeping the newest `pageSize`
 * of the union — which is exactly the newest `pageSize` overall. `before`
 * walks backwards from the oldest entry already shown.
 */
export async function getTaskDetail(
  db: Db,
  taskId: string,
  options: { pageSize?: number; before?: Date } = {},
): Promise<TaskDetail | null> {
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

  const pageSize = Math.max(
    1,
    Math.min(500, Math.floor(options.pageSize ?? TASK_TIMELINE_PAGE_SIZE)),
  );
  const before = options.before;
  const olderThan = (column: PgColumn) => (before ? lt(column, before) : undefined);

  const [rawToolCalls, rawModelCalls, rawApprovals, rawMessages, taskFiles, actionRows] =
    await Promise.all([
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
        .where(and(eq(toolCalls.taskId, taskId), olderThan(toolCalls.createdAt)))
        .orderBy(desc(toolCalls.createdAt))
        .limit(pageSize),
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
        .where(and(eq(modelCalls.taskId, taskId), olderThan(modelCalls.createdAt)))
        .orderBy(desc(modelCalls.createdAt))
        .limit(pageSize),
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
        .where(and(eq(approvals.taskId, taskId), olderThan(approvals.requestedAt)))
        .orderBy(desc(approvals.requestedAt))
        .limit(pageSize),
      db
        .select({
          id: messages.id,
          createdAt: messages.createdAt,
          role: messages.role,
          text: messages.text,
        })
        .from(messages)
        .where(and(eq(messages.taskId, taskId), olderThan(messages.createdAt)))
        .orderBy(desc(messages.createdAt))
        .limit(pageSize),
      db
        .select({ id: files.id, workspacePath: files.workspacePath, bytes: files.bytes })
        .from(files)
        .where(eq(files.taskId, taskId))
        .orderBy(asc(files.createdAt)),
      // The action summary reads every call in the task, so it deliberately
      // selects no `args` and only enough of `result` to judge the outcome.
      db
        .select({
          id: toolCalls.id,
          createdAt: toolCalls.createdAt,
          finishedAt: toolCalls.finishedAt,
          toolName: toolCalls.toolName,
          status: toolCalls.status,
          result: toolCalls.result,
          error: toolCalls.error,
        })
        .from(toolCalls)
        .where(eq(toolCalls.taskId, taskId))
        .orderBy(asc(toolCalls.step)),
    ]);

  // Newest `pageSize` of the union, then back into reading order.
  const streams = [rawToolCalls, rawModelCalls, rawApprovals, rawMessages];
  const total = streams.reduce((sum, rows) => sum + rows.length, 0);
  const hasMoreTimeline = total > pageSize || streams.some((rows) => rows.length === pageSize);
  const cutoff = [
    ...rawToolCalls.map((row) => row.createdAt),
    ...rawModelCalls.map((row) => row.createdAt),
    ...rawApprovals.map((row) => row.requestedAt),
    ...rawMessages.map((row) => row.createdAt),
  ]
    .sort((a, b) => b.getTime() - a.getTime())
    .slice(0, pageSize)
    .at(-1);
  const onPage = (at: Date) => cutoff === undefined || at.getTime() >= cutoff.getTime();

  const decisionOf = (value: unknown) =>
    (value ?? {}) as { riskTier?: unknown; policyId?: unknown };

  const { autonomyGrant, plan, ...rest } = task;
  const snapshot: TaskSnapshot = { ...rest, plan: record(plan, MAX_RECORDED_CHARS) };
  const taskApprovals = rawApprovals.filter((row) => onPage(row.requestedAt)).reverse();
  // A parked task whose approval is gone is stuck. The page carries only one
  // page of approvals now, so ask the table rather than the page.
  const stuckWaiting =
    task.status === 'waiting_approval' && !(await hasPendingApproval(db, taskId));
  return {
    timezone: agent.timezone,
    task: snapshot,
    toolCalls: rawToolCalls
      .filter((row) => onPage(row.createdAt))
      .reverse()
      .map((row) => {
        const decision = decisionOf(row.decision);
        return {
          id: row.id,
          createdAt: row.createdAt,
          finishedAt: row.finishedAt,
          toolName: row.toolName,
          step: row.step,
          status: row.status,
          riskTier: typeof decision.riskTier === 'string' ? decision.riskTier : null,
          policyId: typeof decision.policyId === 'string' ? decision.policyId : null,
          args: record(row.args, MAX_RECORDED_CHARS),
          result: record(row.result, MAX_RECORDED_CHARS),
          error: record(row.error, MAX_RECORDED_CHARS),
        };
      }),
    modelCalls: rawModelCalls.filter((row) => onPage(row.createdAt)).reverse(),
    approvals: taskApprovals,
    messages: rawMessages
      .filter((row) => onPage(row.createdAt))
      .reverse()
      .map((row) => ({
        ...row,
        text:
          row.text.length > MAX_TIMELINE_MESSAGE_CHARS
            ? `${row.text.slice(0, MAX_TIMELINE_MESSAGE_CHARS)}…`
            : row.text,
      })),
    files: taskFiles,
    actions: actionRows.map((row) => ({
      id: row.id,
      toolName: row.toolName,
      createdAt: row.createdAt,
      finishedAt: row.finishedAt,
      completed: completedSuccessfully(row.status, row.result),
      error: row.error,
      resultPreview: record(row.result, MAX_PREVIEW_CHARS),
    })),
    hasMoreTimeline,
    activeGrant: activeAutonomyGrant(task, Date.now()),
    stuckWaiting,
  };
}

/** Whether an approval on this task is still waiting on the owner. */
async function hasPendingApproval(db: Db, taskId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(and(eq(approvals.taskId, taskId), eq(approvals.status, 'pending')))
    .limit(1);
  return Boolean(row);
}
