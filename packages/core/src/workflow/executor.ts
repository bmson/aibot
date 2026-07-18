import type { Db, TaskRow } from '@assistant/db';
import { approvals, messages, tasks, toolCalls } from '@assistant/db';
import type { ModelMessage } from 'ai';
import { and, eq, inArray } from 'drizzle-orm';
import type { ZodType } from 'zod';
import { type BrowserJobPendingResult, isBrowserJobPending } from '../browse.js';
import {
  buildSystemPrompt,
  getAgent,
  listMessages,
  PROMPT_VERSION,
  persistMessage,
} from '../chat.js';
import {
  BudgetReservationError,
  getRate,
  nextDailyReset,
  nextMonthlyReset,
  reconcileReservation,
} from '../cost.js';
import { type PendingFinal, PlanSchema, type TaskState, type Trust } from '../events.js';
import { getOwnerCard } from '../memory/consolidation.js';
import type { WorkspaceReader } from '../memory/import.js';
import { codeJobName, runCodeJob } from '../memory/jobs.js';
import type { ModelRole, ModelRouter, ProposedToolCall } from '../model-router/router.js';
import { withSpan } from '../otel.js';
import {
  checkpointTask,
  claimTask,
  completeTask,
  markTaskNeedsAttention,
  parkForApproval,
  parkForBudget,
  recordFailedAttempt,
  renewTaskLease,
  sleepTask,
  type TaskLease,
  taskState,
} from './machine.js';
import { startMission, wakeMission } from './missions.js';
import { PLANNER_VERSION, planTask } from './planner.js';
import { type ActionEvidence, enforceResponseContract } from './response-contract.js';

/** Structural port implemented by @assistant/tools' ToolDispatcher — keeps core free of a package cycle. */
export interface DispatcherPort {
  toolDefs(
    trust: Trust,
    tainted?: boolean,
    scope?: { isMissionSession: boolean },
  ): Array<{ name: string; description: string; inputSchema: ZodType }>;
  resultIsUntrusted(toolName: string): boolean;
  dispatch(input: {
    task: TaskRow;
    step: number;
    modelToolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    ctx: ToolContextLike;
    provenance: { plannerVersion: number; promptVersion: number; model: string };
  }): Promise<
    | { kind: 'executed'; toolCallId: string; result: unknown; cached: boolean }
    | {
        kind: 'awaiting_approval';
        toolCallId: string;
        approvalId: string;
        shortCode: string;
        summary: string;
      }
    | { kind: 'rejected'; reason: string }
    | { kind: 'budget_blocked'; reason: string; resumeAt: Date }
  >;
  executeApproved(
    toolCallId: string,
    ctx: ToolContextLike,
  ): Promise<
    | { kind: 'executed'; result: unknown }
    | { kind: 'failed'; error: string }
    | { kind: 'budget_blocked'; reason: string; resumeAt: Date }
  >;
}

export interface ToolContextLike {
  taskId: string;
  agentId: string;
  conversationId?: string;
  trust: Trust;
  tainted: boolean;
  db: Db;
  now: () => Date;
  signal: AbortSignal;
  log: (type: string, payload: unknown) => Promise<void>;
  execution?: { dbToolCallId: string; modelToolCallId: string; toolName: string };
  stageBrowserJob?: (job: {
    dbToolCallId: string;
    modelToolCallId: string;
    toolName: string;
    pending: BrowserJobPendingResult;
  }) => Promise<void>;
  clearStagedBrowserJob?: (job: {
    dbToolCallId: string;
    modelToolCallId: string;
    toolName: string;
    pending: BrowserJobPendingResult;
  }) => Promise<void>;
}

export interface ExecutorDeps {
  db: Db;
  router: ModelRouter;
  dispatcher: DispatcherPort;
  /** Workspace file store — required only for code jobs that read archives (imports). */
  workspace?: WorkspaceReader;
  /** Channel delivery for a task's final text (e.g. SMS reply). Errors are retried by the workflow. */
  deliverFinal?: (task: TaskRow, text: string) => Promise<void>;
  /** Out-of-band owner notification when approvals park a task (e.g. SMS "Reply YES A7"). */
  notifyApproval?: (
    approvals: Array<{ taskId: string; shortCode: string; summary: string }>,
  ) => Promise<void>;
}

export type ExecuteResult = {
  outcome:
    | 'done'
    | 'parked'
    | 'sleeping'
    | 'failed'
    | 'dead_letter'
    | 'not_claimable'
    | 'needs_attention'
    | 'clarify';
  detail?: string;
};

const ROLE_FOR_TYPE: Record<string, ModelRole> = {
  chat_turn: 'draft',
  sms_turn: 'draft',
  email_triage: 'draft',
  scheduled: 'draft',
  mission: 'reason',
  browser_job: 'draft',
  adhoc: 'draft',
};

const RESULT_CHAR_LIMIT = 4000;
const CONTEXT_WINDOW_LIMIT = 40;

const LOST_LEASE: ExecuteResult = {
  outcome: 'not_claimable',
  detail: 'task lease was cancelled, expired, or reclaimed',
};

function truncateResult(result: unknown): unknown {
  const json = JSON.stringify(result ?? null);
  // Round-trip through JSON: results straight from tools may hold Date
  // instances (drizzle rows) or undefined props, which fail the AI SDK's
  // ModelMessage schema on the NEXT step's validation (checkpointed windows
  // don't hit this — jsonb already serialized them, which is why retries
  // succeeded where first attempts crashed).
  if (json.length <= RESULT_CHAR_LIMIT) return JSON.parse(json);
  return {
    truncated: true,
    note: `result truncated from ${json.length} chars; full result stored in tool_calls`,
    preview: json.slice(0, RESULT_CHAR_LIMIT),
  };
}

export function toolResultMessage(
  toolCallId: string,
  toolName: string,
  value: unknown,
): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId,
        toolName,
        output: { type: 'json', value: truncateResult(value) },
      },
    ],
  } as ModelMessage;
}

/** Drop-oldest compaction (v1): the storage bound and the model context bound in one. */
function compact(window: ModelMessage[]): ModelMessage[] {
  return window.length <= CONTEXT_WINDOW_LIMIT
    ? window
    : window.slice(window.length - CONTEXT_WINDOW_LIMIT);
}

/**
 * Reconcile a settled browser job's pre-flight reservation to what it
 * actually ran (Phase 27): elapsed seconds × rate, in place of the
 * worst-case estimate that was held at launch. Idempotent — the reservation
 * reconciles once; crash-retries no-op.
 */
async function settleJobReservation(
  db: Db,
  row: { decision: unknown; startedAt: Date | null; id: string },
): Promise<void> {
  const reservationId = (row.decision as { reservationId?: unknown } | null)?.reservationId;
  if (typeof reservationId !== 'string') return;
  try {
    const rate = await getRate(db, 'cloud_run_job_sec');
    const elapsedSeconds = row.startedAt
      ? Math.max(1, Math.round((Date.now() - row.startedAt.getTime()) / 1000))
      : 60;
    await reconcileReservation(db, reservationId, {
      usd: elapsedSeconds * rate.unitPriceUsd,
      quantity: elapsedSeconds,
      unit: rate.unit,
      unitPriceUsd: rate.unitPriceUsd,
      toolCallId: row.id,
      description: 'browser job runtime (reconciled at settle)',
    });
  } catch (err) {
    console.error('job reservation reconcile failed', err);
  }
}

/** Where budget-parked work resumes: the reset of whichever period is exhausted. */
function budgetResumeAt(reason: string): Date {
  return reason.includes('monthly') ? nextMonthlyReset() : nextDailyReset();
}

/**
 * Where this task's final answer lands — the model writes very different
 * replies for an email thread than for a chat bubble, and must know that
 * delivery back through the source channel is automatic.
 */
function channelContext(task: TaskRow): string {
  const payload = (task.trigger as { payload?: Record<string, unknown> } | null)?.payload ?? {};
  switch (task.type) {
    case 'email_triage': {
      const from = typeof payload.from === 'string' ? payload.from : 'the sender';
      const subject = typeof payload.subject === 'string' ? payload.subject : '';
      return [
        `\nThis task was triggered by an email from ${from}${subject ? ` (subject: "${subject}")` : ''}.`,
        task.trust === 'owner'
          ? 'When you finish with a text answer, it is AUTOMATICALLY emailed back to the sender on the same thread — write your final message as that email reply, and complete any needed tool actions (calendar, lookups) BEFORE finishing.'
          : 'The sender is not the owner: nothing is auto-sent. If a reply is warranted, use gmail.create_draft (or gmail.send, which needs owner approval).',
      ].join('\n');
    }
    case 'sms_turn':
      return '\nThis task came in by SMS; your final text goes back as an SMS — keep it short and plain.';
    case 'chat_turn':
      return "\nThis task came from the owner's dashboard chat; your final text appears there as your reply.";
    default:
      return '';
  }
}

/** Parked/paused tasks with a conversation must say so in the thread, not go silent. */
async function postConversationNotice(db: Db, task: TaskRow, text: string): Promise<void> {
  if (!task.conversationId) return;
  await persistMessage(db, {
    conversationId: task.conversationId,
    taskId: task.id,
    role: 'assistant',
    origin: 'assistant',
    parts: [{ type: 'text', text }],
    text,
  }).catch((err) => console.error('conversation notice failed', err));
}

/** A retry must not duplicate the dashboard/chat copy of a final response. */
async function persistFinalConversationOnce(db: Db, task: TaskRow, text: string): Promise<void> {
  if (!task.conversationId) return;
  const [existing] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.taskId, task.id),
        eq(messages.role, 'assistant'),
        eq(messages.origin, 'assistant'),
        eq(messages.text, text),
      ),
    )
    .limit(1);
  if (existing) return;
  await persistMessage(db, {
    conversationId: task.conversationId,
    taskId: task.id,
    role: 'assistant',
    origin: 'assistant',
    parts: [{ type: 'text', text }],
    text,
  });
}

/** Deliver a previously checkpointed final response, then finish under CAS. */
async function finalizePendingResponse(
  deps: ExecutorDeps,
  task: TaskLease,
  pending: PendingFinal,
  checkpointState?: TaskState,
): Promise<ExecuteResult> {
  if (!(await renewTaskLease(deps.db, task))) return LOST_LEASE;
  await persistFinalConversationOnce(deps.db, task, pending.text);

  // Check cancellation/reclaim immediately before the external side effect.
  if (deps.deliverFinal && !pending.deliveryAttempted) {
    // Fence the provider call at-most-once. If the process disappears after
    // provider acceptance but before task completion, the retry assumes this
    // ambiguous attempt may have delivered instead of sending a duplicate.
    pending.deliveryAttempted = true;
    const state = checkpointState ?? taskState(task);
    state.pendingFinal = pending;
    if (!(await checkpointTask(deps.db, task, state))) return LOST_LEASE;
    if (!(await renewTaskLease(deps.db, task))) return LOST_LEASE;
    try {
      await deps.deliverFinal(task, pending.text);
    } catch (error) {
      // A definitive provider rejection is retryable. Ambiguous transport
      // failures are normalized by channel adapters and do not throw.
      pending.deliveryAttempted = false;
      state.pendingFinal = pending;
      if (!(await checkpointTask(deps.db, task, state))) return LOST_LEASE;
      throw error;
    }
  }

  const completed = await completeTask(deps.db, task, {
    status: pending.terminalStatus,
    progress: pending.progress,
  });
  if (!completed) return LOST_LEASE;
  return { outcome: pending.outcome, detail: pending.progress.slice(0, 200) };
}

/** Persist-before-send turns the task checkpoint into a small durable outbox. */
async function stageFinalResponse(
  deps: ExecutorDeps,
  task: TaskLease,
  state: TaskState,
  window: ModelMessage[],
  pending: PendingFinal,
): Promise<ExecuteResult> {
  state.pendingFinal = pending;
  state.contextWindow = compact(window) as unknown as TaskState['contextWindow'];
  if (!(await checkpointTask(deps.db, task, state))) return LOST_LEASE;
  return finalizePendingResponse(deps, task, pending, state);
}

/**
 * The prose model is never the evidence source for an external action. Query
 * the durable ledger immediately before publishing a free-form final answer;
 * this also covers tool failures that were visible to the model but ignored.
 */
async function stageModelFinalResponse(
  deps: ExecutorDeps,
  task: TaskLease,
  state: TaskState,
  window: ModelMessage[],
  pending: PendingFinal,
): Promise<ExecuteResult> {
  const rows = await deps.db
    .select({
      toolName: toolCalls.toolName,
      status: toolCalls.status,
      result: toolCalls.result,
      error: toolCalls.error,
    })
    .from(toolCalls)
    .where(eq(toolCalls.taskId, task.id));
  const evidence: ActionEvidence[] = rows;
  const checked = enforceResponseContract(pending.text, evidence);
  const text = checked.text;
  if (checked.blocked) {
    console.warn('blocked unsupported assistant action claim', {
      taskId: task.id,
      unsupported: checked.unsupported,
      toolCalls: rows.map((row) => ({ toolName: row.toolName, status: row.status })),
    });
  }
  return stageFinalResponse(deps, task, state, window, {
    ...pending,
    text,
    progress: text.slice(0, 200),
  });
}

async function seedContext(db: Db, task: TaskRow): Promise<ModelMessage[]> {
  if (task.conversationId) {
    if (task.trust === 'known' || task.trust === 'unknown') {
      const trigger = task.trigger as {
        source?: unknown;
        payload?: { messageId?: unknown };
      } | null;
      const messageId =
        trigger?.source === 'email' && typeof trigger.payload?.messageId === 'string'
          ? trigger.payload.messageId
          : undefined;
      if (messageId) {
        const [inbound] = await db
          .select({ text: messages.text })
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, task.conversationId),
              eq(messages.channelMessageId, `gmail:${messageId}`),
            ),
          )
          .limit(1);
        if (inbound) return [{ role: 'user', content: inbound.text } as ModelMessage];
      }
      // Never expose the rest of a private bound conversation to an external
      // sender when no event-specific message can be proven.
      return [
        {
          role: 'user',
          content: `External task trigger (${task.type}):\n${JSON.stringify(task.trigger)}`,
        } as ModelMessage,
      ];
    }
    const rows = await listMessages(db, task.conversationId);
    return rows
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-20)
      .map(
        (m) =>
          ({ role: m.role as 'user' | 'assistant', content: m.text || '(empty)' }) as ModelMessage,
      );
  }
  return [
    {
      role: 'user',
      content: `Task trigger (${task.type}):\n\`\`\`json\n${JSON.stringify(task.trigger)}\n\`\`\``,
    } as ModelMessage,
  ];
}

/**
 * The workflow executor: claim → load checkpoint → (plan) → step loop
 * (model proposes tools → risk gate dispatches) → checkpoint each step →
 * park / sleep / complete. Resume is *load state, continue* — never replay.
 */
export async function executeTask(deps: ExecutorDeps, taskId: string): Promise<ExecuteResult> {
  const { db } = deps;
  const task = await claimTask(db, taskId);
  if (!task) return { outcome: 'not_claimable' };

  return withSpan('task.execute', { taskId, type: task.type, attempt: task.attempt }, async () => {
    try {
      return await runSteps(deps, task);
    } catch (err) {
      if (err instanceof BudgetReservationError) {
        if (err.message.startsWith('task budget')) {
          const marked = await markTaskNeedsAttention(db, task, `budget: ${err.message}`);
          if (!marked) return LOST_LEASE;
          await postConversationNotice(
            db,
            task,
            `I hit this task's own budget cap (${err.message}) and stopped. Raise the task budget on the Tasks page if you want it retried.`,
          );
          return { outcome: 'needs_attention', detail: err.message.slice(0, 500) };
        }
        const [fresh] = await db.select().from(tasks).where(eq(tasks.id, task.id));
        const parked = await parkForBudget(db, task, taskState(fresh ?? task), err.resumeAt);
        if (!parked) return LOST_LEASE;
        await postConversationNotice(
          db,
          task,
          `I'm pausing here — ${err.message}. This resumes automatically when the budget resets.`,
        );
        return { outcome: 'parked', detail: err.message.slice(0, 500) };
      }
      const disposition = await recordFailedAttempt(db, task, String(err));
      if (disposition === 'lost_lease') return LOST_LEASE;
      return {
        outcome: disposition === 'dead_letter' ? 'dead_letter' : 'failed',
        detail: String(err).slice(0, 500),
      };
    }
  });
}

async function runSteps(deps: ExecutorDeps, task: TaskLease): Promise<ExecuteResult> {
  const { db, router, dispatcher } = deps;
  const lease = task;
  const state = taskState(task);
  if (state.pendingFinal) return finalizePendingResponse(deps, lease, state.pendingFinal, state);

  const triggerSource = (task.trigger as { source?: unknown } | null)?.source;
  if (task.trust === 'known' || task.trust === 'unknown' || triggerSource === 'email') {
    state.untrustedContext = true;
  }

  const agent = await getAgent(db);
  const abort = new AbortController();

  // Code jobs (nightly memory extraction/consolidation, imports) run a
  // registered function instead of the model loop — same retry/budget
  // machinery. A job may yield (done: false) to sleep and resume later from
  // its own checkpoint in tasks.state.
  const job = codeJobName(task);
  if (job) {
    const outcome = await runCodeJob(
      {
        db,
        router,
        workspace: deps.workspace,
        heartbeat: async () => {
          if (!(await renewTaskLease(db, lease))) throw new Error('task lease lost');
        },
      },
      job,
      task,
    );
    if (!(await renewTaskLease(db, lease))) return LOST_LEASE;
    if (!outcome.done) {
      const [fresh] = await db.select().from(tasks).where(eq(tasks.id, task.id));
      const slept = await sleepTask(
        db,
        lease,
        taskState(fresh ?? task),
        outcome.runAfter ?? new Date(Date.now() + 5000),
      );
      if (!slept) return LOST_LEASE;
      return { outcome: 'sleeping', detail: outcome.summary.slice(0, 200) };
    }
    const completed = await completeTask(db, lease, {
      status: 'done',
      progress: outcome.summary.slice(0, 500),
    });
    if (!completed) return LOST_LEASE;
    return { outcome: 'done', detail: outcome.summary.slice(0, 200) };
  }

  // Missions never run the step loop themselves: each wake is a deadline
  // check, a reflection, or a fresh bounded session child.
  if (task.type === 'mission') {
    const wake = await wakeMission({ db, router }, task, agent);
    if (wake.action === 'lease_lost') return LOST_LEASE;
    return {
      outcome: wake.action === 'deadline_reached' ? 'done' : 'sleeping',
      detail: wake.action,
    };
  }

  let window = state.contextWindow as unknown as ModelMessage[];
  if (window.length === 0) {
    window = await seedContext(db, task);
  }
  let browserStageRemainder: ProposedToolCall[] = [];
  const browserStageSnapshots = new Map<
    string,
    { contextWindow: TaskState['contextWindow']; pendingJob: TaskState['pendingJob'] }
  >();

  const ctx: ToolContextLike = {
    taskId: task.id,
    agentId: task.agentId,
    conversationId: task.conversationId ?? undefined,
    trust: task.trust as Trust,
    tainted: state.untrustedContext,
    db,
    now: () => new Date(),
    signal: abort.signal,
    log: async () => {},
    stageBrowserJob: async (job) => {
      const pendingJob = {
        dbToolCallId: job.dbToolCallId,
        toolCallId: job.modelToolCallId,
        toolName: job.toolName,
        callbackToken: job.pending.callbackToken,
        timeoutAt: job.pending.timeoutAt,
      };
      // The model may have proposed several calls in one assistant message. A
      // crash after launch cannot leave dangling tool calls in the durable
      // transcript, so calls after browser.execute are checkpointed as refused
      // exactly as the live loop will refuse them below.
      const durableWindow = [
        ...window,
        ...browserStageRemainder.map((call) =>
          toolResultMessage(call.toolCallId, call.toolName, {
            error:
              'a browser job is already running for this task — wait for its result before making more tool calls',
          }),
        ),
      ];
      const contextWindow = compact(durableWindow) as unknown as TaskState['contextWindow'];
      const snapshot = {
        contextWindow: state.contextWindow,
        pendingJob: state.pendingJob,
      };
      // If this is an approved call, remove the approval from the DURABLE
      // recovery checkpoint before launch. Keep the in-memory list untouched so
      // the current loop can continue processing its remaining approvals.
      const checkpointState: TaskState = {
        ...state,
        pendingApprovals: state.pendingApprovals.filter(
          (approval) => approval.dbToolCallId !== job.dbToolCallId,
        ),
        pendingJob,
        contextWindow,
      };
      await db.transaction(async (tx) => {
        const [staged] = await tx
          .update(toolCalls)
          .set({ result: job.pending })
          .where(
            and(
              eq(toolCalls.id, job.dbToolCallId),
              eq(toolCalls.taskId, task.id),
              eq(toolCalls.status, 'executing'),
            ),
          )
          .returning({ id: toolCalls.id });
        if (!staged) throw new Error('browser tool call could not be staged');
        if (!(await checkpointTask(tx as unknown as Db, lease, checkpointState))) {
          throw new Error('task lease lost while staging browser job');
        }
      });
      browserStageSnapshots.set(job.dbToolCallId, snapshot);
      state.pendingJob = pendingJob;
      state.contextWindow = contextWindow;
    },
    clearStagedBrowserJob: async (job) => {
      const snapshot = browserStageSnapshots.get(job.dbToolCallId);
      const checkpointState: TaskState = {
        ...state,
        pendingJob: snapshot?.pendingJob ?? null,
        contextWindow: snapshot?.contextWindow ?? state.contextWindow,
      };
      await db.transaction(async (tx) => {
        const [cleared] = await tx
          .update(toolCalls)
          .set({ result: null })
          .where(
            and(
              eq(toolCalls.id, job.dbToolCallId),
              eq(toolCalls.taskId, task.id),
              eq(toolCalls.status, 'executing'),
            ),
          )
          .returning({ id: toolCalls.id });
        if (!cleared) throw new Error('staged browser tool call could not be cleared');
        if (!(await checkpointTask(tx as unknown as Db, lease, checkpointState))) {
          throw new Error('task lease lost while clearing browser job');
        }
      });
      state.pendingJob = checkpointState.pendingJob;
      state.contextWindow = checkpointState.contextWindow;
      browserStageSnapshots.delete(job.dbToolCallId);
    },
  };

  // ── Resume: settle a finished (or timed-out) browser job ──────────────────
  // The job's callback replaced the sentinel result on the tool_calls row
  // before waking us; if we woke for another reason (approval resolution)
  // while the job is still in flight, leave pendingJob set — the post-approval
  // check below puts the task back to sleep until the job's timeout.
  if (state.pendingJob) {
    const pending = state.pendingJob;
    const [row] = await db.select().from(toolCalls).where(eq(toolCalls.id, pending.dbToolCallId));
    const timedOut = Date.now() >= new Date(pending.timeoutAt).getTime();
    if (row && !isBrowserJobPending(row.result)) {
      window.push(toolResultMessage(pending.toolCallId, pending.toolName, row.result));
      if (dispatcher.resultIsUntrusted(pending.toolName)) {
        state.untrustedContext = true;
        ctx.tainted = true;
      }
      state.completedToolCallIds.push(pending.dbToolCallId);
      state.pendingJob = null;
      await settleJobReservation(db, row);
    } else if (timedOut || !row) {
      const settled = {
        ok: false,
        error: 'the browser job never reported back (timed out) — treat this attempt as failed',
      };
      if (row) {
        await db
          .update(toolCalls)
          .set({
            status: 'failed',
            result: settled,
            error: settled.error,
            finishedAt: new Date(),
          })
          .where(eq(toolCalls.id, row.id));
        await settleJobReservation(db, row);
      }
      window.push(toolResultMessage(pending.toolCallId, pending.toolName, settled));
      state.completedToolCallIds.push(pending.dbToolCallId);
      state.pendingJob = null;
    }
  }

  // ── Resume: settle pending approvals first ────────────────────────────────
  if (state.pendingApprovals.length > 0) {
    const rows = await db
      .select()
      .from(approvals)
      .where(
        inArray(
          approvals.id,
          state.pendingApprovals.map((p) => p.approvalId),
        ),
      );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const stillPending: typeof state.pendingApprovals = [];

    for (let i = 0; i < state.pendingApprovals.length; i += 1) {
      const pending = state.pendingApprovals[i] as (typeof state.pendingApprovals)[number];
      const approval = byId.get(pending.approvalId);
      if (!approval || approval.status === 'pending') {
        stillPending.push(pending);
        continue;
      }
      if (approval.status === 'approved') {
        // One browser job at a time — defer further approved calls until the
        // in-flight job settles; they stay parked and run on the next wake.
        if (state.pendingJob) {
          stillPending.push(pending);
          continue;
        }
        if (!(await renewTaskLease(db, lease))) return LOST_LEASE;
        const outcome = await dispatcher.executeApproved(pending.dbToolCallId, ctx);
        if (outcome.kind === 'budget_blocked') {
          // Keep this approved call (and every unprocessed call) in the
          // checkpoint. Approval grants permission, not unlimited spend.
          state.pendingApprovals = [...stillPending, ...state.pendingApprovals.slice(i)];
          state.contextWindow = compact(window) as unknown as TaskState['contextWindow'];
          const parked = await parkForBudget(db, lease, state, outcome.resumeAt);
          if (!parked) return LOST_LEASE;
          await postConversationNotice(
            db,
            task,
            `I'm pausing here — the approved action doesn't fit the remaining budget (${outcome.reason}). It resumes automatically when the budget resets.`,
          );
          return { outcome: 'parked', detail: outcome.reason };
        }
        if (outcome.kind === 'executed' && isBrowserJobPending(outcome.result)) {
          // The approved call launched a browser job — park for its callback.
          window.push(
            toolResultMessage(pending.toolCallId, pending.toolName, {
              status: 'browser_job_running',
              note: 'the job is running; its results will arrive in the next turn',
            }),
          );
          state.pendingJob = {
            dbToolCallId: pending.dbToolCallId,
            toolCallId: pending.toolCallId,
            toolName: pending.toolName,
            callbackToken: outcome.result.callbackToken,
            timeoutAt: outcome.result.timeoutAt,
          };
        } else {
          window.push(
            toolResultMessage(
              pending.toolCallId,
              pending.toolName,
              outcome.kind === 'executed' ? outcome.result : { error: outcome.error },
            ),
          );
          state.completedToolCallIds.push(pending.dbToolCallId);
          if (outcome.kind === 'executed' && dispatcher.resultIsUntrusted(pending.toolName)) {
            state.untrustedContext = true;
            ctx.tainted = true;
          }
        }
      } else {
        window.push(
          toolResultMessage(pending.toolCallId, pending.toolName, {
            denied: true,
            reason:
              approval.status === 'expired'
                ? 'approval expired before the owner responded'
                : 'the owner denied this action',
          }),
        );
      }
    }

    if (stillPending.length > 0) {
      state.contextWindow = compact(window) as unknown as TaskState['contextWindow'];
      const parked = await parkForApproval(db, lease, state, stillPending);
      if (!parked) return LOST_LEASE;
      return { outcome: 'parked', detail: 'still waiting on approvals' };
    }
    state.pendingApprovals = [];
  }

  // A browser job is (still) in flight — sleep until its callback or timeout.
  if (state.pendingJob) {
    state.contextWindow = compact(window) as unknown as TaskState['contextWindow'];
    const slept = await sleepTask(db, lease, state, new Date(state.pendingJob.timeoutAt));
    if (!slept) return LOST_LEASE;
    return { outcome: 'sleeping', detail: 'browser job running' };
  }

  // ── Plan (decide, don't execute) ──────────────────────────────────────────
  let plan = task.plan ? PlanSchema.parse(task.plan) : null;
  if (!plan) {
    plan = await planTask({ db, router }, task, agent, window);
    if (!(await renewTaskLease(db, lease))) return LOST_LEASE;
    if (plan?.action === 'mission') {
      if (state.untrustedContext || (task.trust !== 'owner' && task.trust !== 'assistant')) {
        const refused = 'I did not start a long-running mission from an external request.';
        window.push({ role: 'assistant', content: refused } as ModelMessage);
        return stageFinalResponse(deps, lease, state, window, {
          text: refused,
          progress: 'refused externally triggered mission',
          terminalStatus: 'done',
          outcome: 'done',
        });
      }
      const statement = plan.steps.length
        ? `${plan.reasoning || 'Long-horizon work'} — steps: ${plan.steps.join('; ')}`
        : plan.reasoning || 'Long-horizon work from owner request';
      const mission = await startMission(db, task, plan, statement);
      const confirmation = `Started a mission for this (id ${mission.id.slice(0, 8)}). I'll work on it in daily sessions, reflect weekly on whether it's still worth pursuing, and report as things happen. It's visible under Monitoring on the dashboard.`;
      window.push({ role: 'assistant', content: confirmation } as ModelMessage);
      return stageFinalResponse(deps, lease, state, window, {
        text: confirmation,
        progress: `spawned mission ${mission.id}`,
        terminalStatus: 'done',
        outcome: 'done',
      });
    }
    if (plan?.action === 'clarify' && task.conversationId) {
      const question =
        plan.missingInfo.length > 0
          ? `Before I proceed, I need to know: ${plan.missingInfo.join('; ')}`
          : 'I need more detail before I can act on this — what exactly would you like me to do?';
      window.push({ role: 'assistant', content: question } as ModelMessage);
      return stageFinalResponse(deps, lease, state, window, {
        text: question,
        progress: 'asked for clarification',
        terminalStatus: 'done',
        outcome: 'clarify',
      });
    }
  }

  const role = ROLE_FOR_TYPE[task.type] ?? 'draft';
  const privilegedTask = task.trust === 'owner' || task.trust === 'assistant';
  const ownerCard = privilegedTask && !state.untrustedContext ? await getOwnerCard(db) : undefined;

  // Owner chat/SMS replies are the critical carve-out: hard caps degrade
  // them to the fallback model instead of blocking (evaluateBudget).
  const critical =
    (task.type === 'chat_turn' || task.type === 'sms_turn') && task.trust === 'owner';

  // ── Step loop ─────────────────────────────────────────────────────────────
  while (state.step < task.maxSteps) {
    // Rebuild the system prompt after each tool turn. Once an external result
    // taints the context, the private owner card is removed from every later
    // model call instead of lingering in a constant system prompt.
    const system = [
      buildSystemPrompt(agent, {
        ownerCard: !state.untrustedContext ? ownerCard : undefined,
      }),
      channelContext(task),
      plan
        ? `\nCurrent plan (follow it; deviate only with good reason):\n${JSON.stringify(plan)}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');
    const toolDefs = dispatcher.toolDefs(task.trust as Trust, state.untrustedContext, {
      isMissionSession: task.type === 'adhoc' && task.parentTaskId !== null,
    });
    const toolSet = Object.fromEntries(
      toolDefs.map((def) => [
        def.name,
        { description: def.description, inputSchema: def.inputSchema },
      ]),
    );
    const stepResult = await router.step(role, {
      taskId: task.id,
      system,
      messages: window,
      tools: toolSet as never,
      critical,
    });
    if (!(await renewTaskLease(db, lease))) return LOST_LEASE;

    if (!stepResult.ok) {
      if (stepResult.decision.mode === 'block') {
        // daily/monthly exhausted — park as waiting_budget until the period
        // resets (checkpointed at this step boundary, never killed mid-step)
        state.contextWindow = compact(window) as unknown as TaskState['contextWindow'];
        const parked = await parkForBudget(
          db,
          lease,
          state,
          budgetResumeAt(stepResult.decision.reason),
        );
        if (!parked) return LOST_LEASE;
        await postConversationNotice(
          db,
          task,
          `I'm pausing here — ${stepResult.decision.reason}. This resumes automatically when the budget resets; you can also raise the caps on the Costs page.`,
        );
        return { outcome: 'parked', detail: stepResult.decision.reason };
      }
      // task budget exhausted — surface to the owner on the dashboard
      const marked = await markTaskNeedsAttention(
        db,
        lease,
        `budget: ${stepResult.decision.reason}`,
      );
      if (!marked) return LOST_LEASE;
      await postConversationNotice(
        db,
        task,
        `I hit this task's own budget cap (${stepResult.decision.reason}) and stopped. It's marked needs-attention on the Tasks page — raise the task budget there if you want me to finish.`,
      );
      return { outcome: 'needs_attention', detail: stepResult.decision.reason };
    }

    // 'length' means the model was cut off at the token budget. With no tool
    // calls we still hold a (possibly truncated) text answer that is far better
    // to deliver than to fail the whole turn on — this is the last-line guard
    // for reasoning models that spend their budget thinking. Truncated tool
    // arguments, by contrast, are unsafe to dispatch, so a cut-off mid-tool-call
    // stays a hard failure.
    const cutOffWithText =
      stepResult.finishReason === 'length' && stepResult.toolCalls.length === 0;
    const successfulFinish =
      stepResult.finishReason === undefined ||
      stepResult.finishReason === 'stop' ||
      (stepResult.toolCalls.length > 0 && stepResult.finishReason === 'tool-calls') ||
      cutOffWithText;
    if (!successfulFinish) {
      throw new Error(`model step ended with finish reason ${stepResult.finishReason}`);
    }

    state.step += 1;

    // assistant turn (text and/or tool calls) into the window
    if (stepResult.toolCalls.length > 0) {
      window.push({
        role: 'assistant',
        content: [
          ...(stepResult.text ? [{ type: 'text' as const, text: stepResult.text }] : []),
          ...stepResult.toolCalls.map((tc) => ({
            type: 'tool-call' as const,
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            input: tc.input,
          })),
        ],
      } as ModelMessage);

      const pendingApprovals: TaskState['pendingApprovals'] = [];
      const approvalNotices: Array<{ taskId: string; shortCode: string; summary: string }> = [];
      for (let toolIndex = 0; toolIndex < stepResult.toolCalls.length; toolIndex += 1) {
        const tc = stepResult.toolCalls[toolIndex] as (typeof stepResult.toolCalls)[number];
        // One browser job at a time: once a call in this batch launched a job,
        // later calls are refused undispatched (parallel launches would race
        // the shared profile and orphan all but the last callback token).
        if (state.pendingJob) {
          window.push(
            toolResultMessage(tc.toolCallId, tc.toolName, {
              error:
                'a browser job is already running for this task — wait for its result before making more tool calls',
            }),
          );
          continue;
        }
        if (!(await renewTaskLease(db, lease))) return LOST_LEASE;
        browserStageRemainder = stepResult.toolCalls.slice(toolIndex + 1);
        const outcome = await dispatcher.dispatch({
          task,
          step: state.step,
          modelToolCallId: tc.toolCallId,
          toolName: tc.toolName,
          args: tc.input,
          ctx,
          provenance: {
            plannerVersion: PLANNER_VERSION,
            promptVersion: PROMPT_VERSION,
            model: stepResult.modelId,
          },
        });
        browserStageRemainder = [];

        if (outcome.kind === 'executed') {
          if (isBrowserJobPending(outcome.result)) {
            window.push(
              toolResultMessage(tc.toolCallId, tc.toolName, {
                status: 'browser_job_running',
                note: 'the job is running; its results will arrive in the next turn',
              }),
            );
            state.pendingJob = {
              dbToolCallId: outcome.toolCallId,
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              callbackToken: outcome.result.callbackToken,
              timeoutAt: outcome.result.timeoutAt,
            };
          } else {
            window.push(toolResultMessage(tc.toolCallId, tc.toolName, outcome.result));
            state.completedToolCallIds.push(outcome.toolCallId);
            if (dispatcher.resultIsUntrusted(tc.toolName)) {
              state.untrustedContext = true;
              ctx.tainted = true;
            }
          }
        } else if (outcome.kind === 'budget_blocked') {
          // The pre-flight reservation failed: this expensive action does not
          // fit the remaining budget. Park BEFORE launching anything — the
          // task resumes (and the model retries the call) when the cap resets.
          window.push(
            toolResultMessage(tc.toolCallId, tc.toolName, {
              deferred: true,
              reason: outcome.reason,
              note: 'budget exhausted — the task is parked and will retry this action when the budget resets',
            }),
          );
          state.contextWindow = compact(window) as unknown as TaskState['contextWindow'];
          const parked = await parkForBudget(db, lease, state, outcome.resumeAt);
          if (!parked) return LOST_LEASE;
          await postConversationNotice(
            db,
            task,
            `I'm pausing here — this action doesn't fit the remaining budget (${outcome.reason}). The task resumes automatically when the budget resets; you can also raise the caps on the Costs page.`,
          );
          return { outcome: 'parked', detail: outcome.reason };
        } else if (outcome.kind === 'awaiting_approval') {
          window.push(
            toolResultMessage(tc.toolCallId, tc.toolName, {
              status: 'awaiting_owner_approval',
              approvalShortCode: outcome.shortCode,
              summary: outcome.summary,
            }),
          );
          pendingApprovals.push({
            approvalId: outcome.approvalId,
            toolCallId: tc.toolCallId,
            dbToolCallId: outcome.toolCallId,
            toolName: tc.toolName,
          });
          approvalNotices.push({
            taskId: task.id,
            shortCode: outcome.shortCode,
            summary: outcome.summary,
          });
        } else {
          window.push(toolResultMessage(tc.toolCallId, tc.toolName, { error: outcome.reason }));
        }
      }

      window = compact(window);
      state.contextWindow = window as unknown as TaskState['contextWindow'];

      if (pendingApprovals.length > 0) {
        const parked = await parkForApproval(db, lease, state, pendingApprovals);
        if (!parked) return LOST_LEASE;
        if (deps.notifyApproval && approvalNotices.length > 0) {
          await deps
            .notifyApproval(approvalNotices)
            .catch((err) => console.error('approval notification failed', err));
        }
        // The conversation must not go silent while parked — tell the owner
        // exactly what is waiting and where to approve it.
        await postConversationNotice(
          db,
          task,
          [
            'This needs your approval before I act:',
            ...approvalNotices.map((n) => `- **[${n.shortCode}]** ${n.summary}`),
            "Approve or deny it on the Approvals page — I'll pick up from there.",
          ].join('\n'),
        );
        return { outcome: 'parked', detail: `${pendingApprovals.length} approval(s) pending` };
      }

      if (state.pendingJob) {
        const slept = await sleepTask(db, lease, state, new Date(state.pendingJob.timeoutAt));
        if (!slept) return LOST_LEASE;
        return { outcome: 'sleeping', detail: 'browser job running' };
      }

      if (!(await checkpointTask(db, lease, state))) return LOST_LEASE;
      continue;
    }

    // no tool calls → final answer
    const text = stepResult.text.trim() || '(no response)';
    window.push({ role: 'assistant', content: text } as ModelMessage);
    return stageModelFinalResponse(deps, lease, state, window, {
      text,
      progress: text.slice(0, 200),
      terminalStatus: 'done',
      outcome: 'done',
    });
  }

  // max steps exhausted
  const stuck = `stopped after ${task.maxSteps} steps without finishing`;
  const stuckMessage = `I ${stuck}. Here's where I got: ${state.scratchpad || 'see task log.'}`;
  window.push({ role: 'assistant', content: stuckMessage } as ModelMessage);
  return stageFinalResponse(deps, lease, state, window, {
    text: stuckMessage,
    progress: stuck,
    terminalStatus: 'failed',
    outcome: 'failed',
  });
}
