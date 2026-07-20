import type { Db, TaskRow } from '@assistant/db';
import { approvals, goals, messages, tasks, toolCalls } from '@assistant/db';
import type { ModelMessage } from 'ai';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { ZodType } from 'zod';
import { type BrowserJobPendingResult, hashCallbackToken, isBrowserJobPending } from '../browse.js';
import {
  assistantMessageParts,
  buildSystemPrompt,
  getAgent,
  listMessages,
  PROMPT_VERSION,
  persistMessage,
} from '../chat.js';
import { loadConfig } from '../config.js';
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
import { type RecallSource, recallRelevantContext, recentWindowStart } from '../memory/recall.js';
import type { ModelRole, ModelRouter, ProposedToolCall } from '../model-router/router.js';
import { withSpan } from '../otel.js';
import {
  type ArtifactIntent,
  artifactExecutionFailure,
  artifactRoutingFailure,
  artifactToolUnavailable,
  documentReadDispatchFailure,
  needsArtifactToolRetry,
  requestedArtifactIntent,
  requestedDocumentReadIntent,
} from './artifact-intent.js';
import {
  isGoalWorkEvidence,
  needsGoalProgressToolRetry,
  needsGoalProgressUpdate,
} from './goal-evidence.js';
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
  /**
   * Owner notification when approvals park a task (e.g. SMS "Reply YES A7").
   *
   * Receives the task so the deliverer can also answer on the channel the
   * request arrived on. That matters for email: parking otherwise leaves the
   * thread the owner is watching completely silent, because
   * postConversationNotice only writes a dashboard row.
   */
  notifyApproval?: (
    task: TaskRow,
    approvals: Array<{ taskId: string; shortCode: string; summary: string }>,
  ) => Promise<void>;
  /**
   * Out-of-band owner ping for async events the owner would otherwise only see
   * by opening the dashboard: a task that permanently failed (dead-letter), a
   * task stalled on its own budget cap, or a mission that needs a decision.
   * Delivered to the owner's channel (e.g. SMS) in addition to the dashboard
   * conversation notice. Best-effort — callers swallow its errors.
   */
  notifyOwner?: (input: {
    taskId: string;
    conversationId: string | null;
    text: string;
  }) => Promise<void>;
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

/** Latest direct owner wording, used only for deterministic artifact routing. */
function latestUserText(window: ModelMessage[]): string | undefined {
  for (let i = window.length - 1; i >= 0; i -= 1) {
    const message = window[i];
    if (message?.role === 'user' && typeof message.content === 'string') {
      return message.content;
    }
  }
  return undefined;
}

/** The most recent owner-supplied Google Doc URL still present in this chat. */
function sharedDocumentIntent(window: ModelMessage[]) {
  for (let i = window.length - 1; i >= 0; i -= 1) {
    const message = window[i];
    if (message?.role !== 'user' || typeof message.content !== 'string') continue;
    const intent = requestedDocumentReadIntent(message.content);
    if (intent) return intent;
  }
  return undefined;
}

/** Avoid repeatedly re-reading the same shared document on every chat turn. */
async function unreadSharedDocumentIntent(db: Db, task: TaskRow, window: ModelMessage[]) {
  if (task.trust !== 'owner') return undefined;
  const intent = sharedDocumentIntent(window);
  if (!intent || !task.conversationId) return intent;
  const [alreadyRead] = await db
    .select({ id: toolCalls.id })
    .from(toolCalls)
    .innerJoin(tasks, eq(tasks.id, toolCalls.taskId))
    .where(
      and(
        eq(tasks.conversationId, task.conversationId),
        eq(toolCalls.toolName, intent.toolName),
        eq(toolCalls.status, 'succeeded'),
        sql`${toolCalls.args}->>'documentId' = ${intent.documentId}`,
      ),
    )
    .limit(1);
  return alreadyRead ? undefined : intent;
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
      if (task.goalId) {
        // Nobody is reading this live, so a message describing what you intend
        // to do reaches no one and changes nothing. Only a tool result does.
        return [
          "\nThis is a goal's automatic work session. The owner is NOT present and will not answer during this run.",
          'Do the work now with your tools — do not describe a plan, promise to report back, or ask a question you could answer yourself by looking.',
          'Everything you know about this goal is already in this prompt. Do NOT re-read your own state: goals.list, memory.recall, conversations.search and workspace.* tell you nothing new here.',
          // Not a style preference — the provenance rule below makes call order
          // decide whether this session can act at all.
          'ORDER MATTERS. Reading anything marks this session as carrying untrusted content, and from that point on every outward call needs the owner to approve it by hand — which, with nobody present, means the session stops. So spend your FIRST tool call on the outward step that moves the goal: browser.plan, then browser.execute (or web.fetch for a plain page). Any lookup you do first permanently costs you the ability to browse this run.',
          'You get one autonomous outward action, so make it count. browser.plan is free — it only plans. Your ONE outward call comes after it, and it must do the entire job: a single read-only browser.execute plan that searches, opens the promising results, and extracts everything you need. Do not spend that one action on a preliminary web.fetch to see what is there; if you would need several pages, ask browser.plan for a headless plan covering all of them.',
          'Not knowing a URL is not a blocker: start from a search results page and navigate from there.',
          'Finish by calling goals.update_progress with what you verified and the concrete next step.',
        ].join('\n');
      }
      return '';
  }
}

/** Parked/paused tasks with a conversation must say so in the thread, not go silent. */
async function postConversationNotice(
  db: Db,
  task: TaskRow,
  text: string,
  extraParts: unknown[] = [],
): Promise<void> {
  if (!task.conversationId) return;
  await persistMessage(db, {
    conversationId: task.conversationId,
    taskId: task.id,
    role: 'assistant',
    origin: 'assistant',
    parts: [{ type: 'text', text }, ...extraParts],
    text,
  }).catch((err) => console.error('conversation notice failed', err));
}

/**
 * Post the dashboard notice AND push it to the owner's channel for events that
 * would otherwise only be visible by opening the dashboard (permanent failure,
 * budget stall). Owner ping is best-effort: a delivery failure must never mask
 * the underlying task outcome.
 */
async function notifyOwnerAndConversation(
  deps: ExecutorDeps,
  task: TaskRow,
  text: string,
): Promise<void> {
  await postConversationNotice(deps.db, task, text);
  if (deps.notifyOwner) {
    await deps
      .notifyOwner({ taskId: task.id, conversationId: task.conversationId, text })
      .catch((err) => console.error('owner notification failed', err));
  }
}

/**
 * A goal's automatic work session runs with nobody watching it. A run that
 * ends without a single verified tool result therefore must not complete as
 * 'done': the owner sees a green task, the goal keeps its old progress line,
 * and the next session is re-seeded with the same stale state — the goal
 * silently spins. Chat turns are excluded on purpose; there the owner is
 * reading the same honesty message in real time.
 */
function isUnattendedGoalSession(task: TaskRow): boolean {
  return task.goalId !== null && task.type !== 'chat_turn' && task.type !== 'sms_turn';
}

/**
 * Park the goal itself, not just the task. goalInstruction() re-seeds every
 * session from these columns, so an unanswered question has to land here or
 * tomorrow's run starts from the same stale line and asks all over again.
 */
async function recordGoalBlocked(db: Db, goalId: string, question: string): Promise<void> {
  await db
    .update(goals)
    .set({ nextAction: `Waiting on the owner: ${question}`.slice(0, 500), updatedAt: sql`now()` })
    .where(eq(goals.id, goalId));
}

async function stopForUnsavedGoalProgress(
  deps: ExecutorDeps,
  task: TaskLease,
  state: TaskState,
  window: ModelMessage[],
  reason: string,
): Promise<ExecuteResult> {
  const text =
    "I completed a verified goal step, but I couldn't save the progress update. Open Activity and retry this task so the goal does not continue from stale information.";
  console.error('required goal progress was not saved', { taskId: task.id, reason });
  if (task.goalId) await recordGoalBlocked(deps.db, task.goalId, text);
  await notifyOwnerAndConversation(
    deps,
    task,
    'A goal completed work but could not save its progress update. The task needs to be retried from Activity.',
  );
  window.push({ role: 'assistant', content: text } as ModelMessage);
  return stageFinalResponse(deps, task, state, window, {
    text,
    progress: text.slice(0, 200),
    terminalStatus: 'needs_attention',
    outcome: 'needs_attention',
  });
}

/** A retry must not duplicate the dashboard/chat copy of a final response. */
async function persistFinalConversationOnce(
  db: Db,
  task: TaskRow,
  text: string,
  recall?: RecallSource[],
): Promise<void> {
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
    parts: assistantMessageParts(text, recall),
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
  const recallSources = (checkpointState ?? taskState(task)).recall ?? undefined;
  await persistFinalConversationOnce(deps.db, task, pending.text, recallSources);

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

  // The final text is delivered first either way; only the resting state of
  // the task differs. needs_attention keeps it re-queueable from the Tasks
  // page instead of closing it out as a completed run.
  const completed =
    pending.terminalStatus === 'needs_attention'
      ? await markTaskNeedsAttention(deps.db, task, pending.progress)
      : await completeTask(deps.db, task, {
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
 * Deferred work is only real once a durable row exists. Left to prose the
 * model answers "I'll keep updating it as I go" — a promise nothing in the
 * system will keep, and which the response contract then has to blank out.
 */
const SCHEDULE_DIRECTIVE =
  '\nThis turn defers work to the future. Before you finish, call task.schedule with a concrete time and a self-contained instruction (or mission.update if this belongs to a mission). Do not promise to continue, watch, or keep updating anything unless that call succeeded — if you cannot schedule it, say so plainly and do the part you can do now.';

const EVIDENCE_COLUMNS = {
  toolName: toolCalls.toolName,
  status: toolCalls.status,
  result: toolCalls.result,
  error: toolCalls.error,
} as const;

/**
 * The prose model is never the evidence source for an external action. Query
 * the durable ledger immediately before publishing a free-form final answer;
 * this also covers tool failures that were visible to the model but ignored.
 *
 * Two scopes: this task's rows decide whether *this* attempt succeeded, and
 * earlier rows from the same conversation let the contract recognise
 * artifacts that genuinely exist. Without the second scope, referring back to
 * a doc built two turns ago was answered with "I have not created anything
 * outside this chat" — a flat falsehood with the doc sitting in Drive. The
 * response contract still refuses to let prior-turn rows authorise a new
 * send, submission, or booking.
 */
async function stageModelFinalResponse(
  deps: ExecutorDeps,
  task: TaskLease,
  state: TaskState,
  window: ModelMessage[],
  pending: PendingFinal,
  expectedArtifact?: ArtifactIntent,
): Promise<ExecuteResult> {
  const rows = await deps.db
    .select(EVIDENCE_COLUMNS)
    .from(toolCalls)
    .where(eq(toolCalls.taskId, task.id));
  const priorRows = task.conversationId
    ? await deps.db
        .select(EVIDENCE_COLUMNS)
        .from(toolCalls)
        .innerJoin(tasks, eq(toolCalls.taskId, tasks.id))
        .where(and(eq(tasks.conversationId, task.conversationId), ne(toolCalls.taskId, task.id)))
    : [];
  const evidence: ActionEvidence[] = [
    ...priorRows.map((row) => ({ ...row, fromCurrentTask: false })),
    ...rows,
  ];
  const explicitFailure = expectedArtifact
    ? artifactExecutionFailure(expectedArtifact, rows)
    : undefined;
  if (explicitFailure) {
    return stageFinalResponse(deps, task, state, window, {
      ...pending,
      text: explicitFailure,
      progress: explicitFailure.slice(0, 200),
      terminalStatus: 'failed',
      outcome: 'failed',
    });
  }
  const checked = enforceResponseContract(pending.text, evidence);
  const text = checked.text;
  if (checked.blocked) {
    console.warn('blocked unsupported assistant action claim', {
      taskId: task.id,
      unsupported: checked.unsupported,
      toolCalls: rows.map((row) => ({ toolName: row.toolName, status: row.status })),
    });
  }
  // An automatic goal session that produced no verified tool result did no
  // work, whatever its prose says. Surfacing it as needs_attention is what
  // turns a goal that is quietly spinning into one the owner can see is stuck.
  if (isUnattendedGoalSession(task) && !rows.some(isGoalWorkEvidence)) {
    if (task.goalId) await recordGoalBlocked(deps.db, task.goalId, text);
    await notifyOwnerAndConversation(
      deps,
      task,
      `This goal's automatic session finished without completing any verified action. It needs you: ${text}`,
    );
    return stageFinalResponse(deps, task, state, window, {
      ...pending,
      text,
      progress: text.slice(0, 200),
      terminalStatus: 'needs_attention',
      outcome: 'needs_attention',
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
    const conversationWindow = rows
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-20)
      .map(
        (m) =>
          ({ role: m.role as 'user' | 'assistant', content: m.text || '(empty)' }) as ModelMessage,
      );
    if (conversationWindow.length > 0) return conversationWindow;

    // A newly-created Goal work chat deliberately does not render the
    // system-generated opening instruction as if the owner had written it.
    // Its durable task trigger remains the source of truth for the first
    // model step, so the work can begin without a misleading chat bubble.
    const trigger = task.trigger as { payload?: { text?: unknown; instruction?: unknown } } | null;
    const initialInstruction =
      typeof trigger?.payload?.text === 'string'
        ? trigger.payload.text
        : typeof trigger?.payload?.instruction === 'string'
          ? trigger.payload.instruction
          : undefined;
    if (initialInstruction) {
      return [{ role: 'user', content: initialInstruction } as ModelMessage];
    }
    return conversationWindow;
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
          await notifyOwnerAndConversation(
            deps,
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
      if (disposition === 'dead_letter') {
        // Retry budget exhausted: the task is now needs_attention and will not
        // self-resume. Every other terminal/park branch notifies the owner, so
        // this one must too — otherwise the request dies silently in its thread.
        await notifyOwnerAndConversation(
          deps,
          task,
          `I couldn't complete this after repeated attempts and stopped. It's marked needs-attention on the Tasks page. Last error: ${String(err).slice(0, 300)}`,
        );
      }
      return {
        outcome: disposition === 'dead_letter' ? 'dead_letter' : 'failed',
        detail: String(err).slice(0, 500),
      };
    }
  });
}

/**
 * Does this task start with externally controlled content in its context?
 *
 * Any non-privileged sender does. Email additionally carries the presumption
 * even from the owner, because forwarded threads and quoted replies are exactly
 * how attacker-controlled text gets inside an authenticated message — that is
 * the provenance boundary the taint gate exists to hold.
 *
 * The presumption is dropped in one case only: a DKIM-verified owner sender
 * (see classifySender — owner trust is unreachable without aligned
 * SPF/DKIM/DMARC) whose body ingestion positively determined carries no forward
 * separator and no quoted block. Every word is then the owner's own, which is
 * no more untrusted than the same words typed into the web chat — a channel
 * that is never tainted. Treating those differently was an unjustified
 * asymmetry that cost the owner an approval on requests they typed themselves.
 *
 * Everything else stays tainted, including a `quotesExternalContent` flag that
 * is absent (tasks enqueued before the check existed) or non-boolean. Only an
 * explicit `false` relaxes anything.
 */
export function shouldTaintContext(task: Pick<TaskRow, 'trust' | 'trigger'>): boolean {
  if (task.trust === 'known' || task.trust === 'unknown') return true;
  const trigger = task.trigger as {
    source?: unknown;
    payload?: { quotesExternalContent?: unknown };
  } | null;
  if (trigger?.source !== 'email') return false;
  const ownerAuthored = task.trust === 'owner' && trigger.payload?.quotesExternalContent === false;
  return !ownerAuthored;
}

async function runSteps(deps: ExecutorDeps, task: TaskLease): Promise<ExecuteResult> {
  const { db, router, dispatcher } = deps;
  const lease = task;
  const state = taskState(task);
  if (state.pendingFinal) return finalizePendingResponse(deps, lease, state.pendingFinal, state);

  if (shouldTaintContext(task)) {
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
    const wake = await wakeMission({ db, router, notifyOwner: deps.notifyOwner }, task, agent);
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
  // A direct document/sheet/slides request skips the generic planner, then
  // forces the matching creation tool. The model still authors the actual
  // title and content; deterministic blank placeholders are never dispatched.
  const artifactIntent =
    state.step === 0 ? requestedArtifactIntent(latestUserText(window) ?? '') : undefined;
  const documentReadIntent =
    state.step === 0 && !artifactIntent
      ? await unreadSharedDocumentIntent(db, task, window)
      : undefined;
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
      // The raw callback token has already been handed to the job at launch;
      // only its hash is persisted anywhere (task checkpoint AND the tool_calls
      // sentinel), so a DB read never yields a usable callback credential.
      const callbackTokenHash = hashCallbackToken(job.pending.callbackToken);
      const stagedSentinel = { ...job.pending, callbackToken: callbackTokenHash };
      const pendingJob = {
        dbToolCallId: job.dbToolCallId,
        toolCallId: job.modelToolCallId,
        toolName: job.toolName,
        callbackTokenHash,
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
          .set({ result: stagedSentinel })
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
    // Settle under a task-row lock. recordBrowserJobResult also locks the task
    // FOR UPDATE before replacing the sentinel, so serializing here closes the
    // window where a late callback commits the real result between our read and
    // a timeout write that would otherwise clobber it. The timeout failure is
    // written only while the sentinel is still present; a real result wins.
    const settled = await db.transaction(async (tx) => {
      await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, task.id)).for('update');
      const [row] = await tx.select().from(toolCalls).where(eq(toolCalls.id, pending.dbToolCallId));
      if (row && !isBrowserJobPending(row.result)) {
        return { kind: 'result' as const, row };
      }
      const timedOut = Date.now() >= new Date(pending.timeoutAt).getTime();
      if (row && !timedOut) return { kind: 'still_pending' as const };
      const failure = {
        ok: false,
        error: 'the browser job never reported back (timed out) — treat this attempt as failed',
      };
      if (row) {
        await tx
          .update(toolCalls)
          .set({ status: 'failed', result: failure, error: failure.error, finishedAt: new Date() })
          .where(eq(toolCalls.id, row.id));
      }
      return { kind: 'timeout' as const, row: row ?? null, failure };
    });

    if (settled.kind === 'result') {
      window.push(toolResultMessage(pending.toolCallId, pending.toolName, settled.row.result));
      if (dispatcher.resultIsUntrusted(pending.toolName)) {
        state.untrustedContext = true;
        ctx.tainted = true;
      }
      state.completedToolCallIds.push(pending.dbToolCallId);
      state.pendingJob = null;
      await settleJobReservation(db, settled.row);
    } else if (settled.kind === 'timeout') {
      if (settled.row) await settleJobReservation(db, settled.row);
      window.push(toolResultMessage(pending.toolCallId, pending.toolName, settled.failure));
      state.completedToolCallIds.push(pending.dbToolCallId);
      state.pendingJob = null;
    }
    // 'still_pending' (row present, sentinel intact, not yet timed out): leave
    // pendingJob set — the sleep-until-timeout below handles it, as before.
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
            callbackTokenHash: hashCallbackToken(outcome.result.callbackToken),
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

  // The owner supplied a real Google Doc URL (commonly a CV). Read it before
  // asking the model to continue, so the assistant has durable evidence of
  // whether it could access the document instead of merely promising to do so.
  if (documentReadIntent && state.step === 0) {
    const outcome = await dispatcher.dispatch({
      task,
      step: state.step,
      modelToolCallId: `direct-document-read-${task.id}`,
      toolName: documentReadIntent.toolName,
      args: { documentId: documentReadIntent.documentId },
      ctx,
      provenance: {
        plannerVersion: PLANNER_VERSION,
        promptVersion: PROMPT_VERSION,
        model: 'direct-document-router',
      },
    });
    if (!(await renewTaskLease(db, lease))) return LOST_LEASE;

    if (outcome.kind === 'budget_blocked') {
      state.contextWindow = compact(window) as unknown as TaskState['contextWindow'];
      const parked = await parkForBudget(db, lease, state, outcome.resumeAt);
      if (!parked) return LOST_LEASE;
      return { outcome: 'parked', detail: outcome.reason };
    }
    if (outcome.kind === 'awaiting_approval') {
      const parked = await parkForApproval(db, lease, state, [
        {
          approvalId: outcome.approvalId,
          dbToolCallId: outcome.toolCallId,
          toolCallId: `direct-document-read-${task.id}`,
          toolName: documentReadIntent.toolName,
        },
      ]);
      if (!parked) return LOST_LEASE;
      if (deps.notifyApproval) {
        await deps
          .notifyApproval(task, [
            { taskId: task.id, shortCode: outcome.shortCode, summary: outcome.summary },
          ])
          .catch((err) => console.error('approval notification failed', err));
      }
      await postConversationNotice(
        db,
        task,
        `I need your approval before reading the shared Google Doc: ${outcome.summary}`,
        [
          {
            type: 'approval',
            approvalId: outcome.approvalId,
            shortCode: outcome.shortCode,
            summary: outcome.summary,
          },
        ],
      );
      return { outcome: 'parked', detail: 'document read awaiting approval' };
    }
    if (outcome.kind !== 'executed') {
      const text = documentReadDispatchFailure(documentReadIntent, outcome.reason);
      window.push({ role: 'assistant', content: text } as ModelMessage);
      return stageFinalResponse(deps, lease, state, window, {
        text,
        progress: text.slice(0, 200),
        terminalStatus: 'failed',
        outcome: 'failed',
      });
    }

    window.push(
      toolResultMessage(
        `direct-document-read-${task.id}`,
        documentReadIntent.toolName,
        outcome.result,
      ),
    );
    state.completedToolCallIds.push(outcome.toolCallId);
    if (dispatcher.resultIsUntrusted(documentReadIntent.toolName)) {
      state.untrustedContext = true;
      ctx.tainted = true;
    }
    state.step += 1;
  }

  let plan = task.plan ? PlanSchema.parse(task.plan) : null;
  if (!plan && !artifactIntent) {
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
      // An automatic goal session has no owner present to answer, so a
      // question is where the goal stops, not a completed run. Record it on
      // the goal and park the task; otherwise the session closes as 'done',
      // the goal keeps its previous progress line, and every later session
      // re-asks the same question into an empty room.
      if (isUnattendedGoalSession(task)) {
        if (task.goalId) await recordGoalBlocked(deps.db, task.goalId, question);
        await notifyOwnerAndConversation(
          deps,
          task,
          `This goal's automatic session is blocked until you answer: ${question}`,
        );
        return stageFinalResponse(deps, lease, state, window, {
          text: question,
          progress: `blocked on owner input: ${question}`.slice(0, 200),
          terminalStatus: 'needs_attention',
          outcome: 'needs_attention',
        });
      }
      return stageFinalResponse(deps, lease, state, window, {
        text: question,
        progress: 'asked for clarification',
        terminalStatus: 'done',
        outcome: 'clarify',
      });
    }
  }

  // A goal's automatic session is the same class of work as a mission:
  // unattended, multi-step, and worthless unless it actually drives tools.
  // The draft model answers these with plausible prose and no tool calls,
  // which is how a goal can report progress for days while doing nothing.
  const role = isUnattendedGoalSession(task) ? 'reason' : (ROLE_FOR_TYPE[task.type] ?? 'draft');
  const privilegedTask = task.trust === 'owner' || task.trust === 'assistant';
  const ownerCard = privilegedTask && !state.untrustedContext ? await getOwnerCard(db) : undefined;

  // Long-running-chat auto-recall (Phase 1). Action-routed chat turns run here
  // instead of the streaming route, so recall is wired at both entry points.
  // Owner-private, so it mirrors the owner-card gate; best-effort by design.
  let recallBlock: string | undefined;
  if (
    loadConfig().CHAT_RECALL_ENABLED &&
    privilegedTask &&
    !state.untrustedContext &&
    task.type === 'chat_turn' &&
    task.conversationId
  ) {
    const conversationId = task.conversationId;
    const lastUser = [...window].reverse().find((m) => m.role === 'user');
    const trigger = task.trigger as { payload?: { text?: unknown } } | null;
    const queryText =
      (typeof lastUser?.content === 'string' && lastUser.content) ||
      (typeof trigger?.payload?.text === 'string' ? trigger.payload.text : '');
    if (queryText) {
      try {
        const since = (await recentWindowStart(db, conversationId, 20)) ?? new Date();
        const recall = await recallRelevantContext(
          db,
          {
            agentId: agent.id,
            queryText,
            embed: (values, embedOpts) =>
              router.embed(values, { taskId: task.id, ...(embedOpts ?? {}) }),
            exclude: { conversationId, sinceCreatedAt: since },
          },
          { taskId: task.id },
        );
        recallBlock = recall.block || undefined;
        // Provenance for the chat UI affordance; checkpointed so it survives to
        // the (possibly resumed) final-response persist.
        state.recall = recall.sources.length > 0 ? recall.sources : undefined;
      } catch (err) {
        console.error('executor recall failed — continuing without it', err);
      }
    }
  }

  // Owner chat/SMS replies are the critical carve-out: hard caps degrade
  // them to the fallback model instead of blocking (evaluateBudget).
  const critical =
    (task.type === 'chat_turn' || task.type === 'sms_turn') && task.trust === 'owner';

  // ── Step loop ─────────────────────────────────────────────────────────────
  while (state.step < task.maxSteps) {
    const goalToolEvidence = isUnattendedGoalSession(task)
      ? await db
          .select({
            toolName: toolCalls.toolName,
            status: toolCalls.status,
            result: toolCalls.result,
            step: toolCalls.step,
          })
          .from(toolCalls)
          .where(eq(toolCalls.taskId, task.id))
      : [];
    const mustRecordGoalProgress = needsGoalProgressUpdate(goalToolEvidence);
    // Rebuild the system prompt after each tool turn. Once an external result
    // taints the context, the private owner card is removed from every later
    // model call instead of lingering in a constant system prompt.
    const system = [
      buildSystemPrompt(agent, {
        ownerCard: !state.untrustedContext ? ownerCard : undefined,
        recall: !state.untrustedContext ? recallBlock : undefined,
        tainted: state.untrustedContext,
      }),
      channelContext(task),
      plan
        ? `\nCurrent plan (follow it; deviate only with good reason):\n${JSON.stringify(plan)}`
        : '',
      plan?.action === 'schedule' ? SCHEDULE_DIRECTIVE : '',
      mustRecordGoalProgress
        ? '\nYou completed a verified goal step. Call goals.update_progress now with only what the tool evidence proves and the best concrete next action. Do not finish in prose first.'
        : '',
    ]
      .filter(Boolean)
      .join('\n');
    const toolDefs = dispatcher.toolDefs(task.trust as Trust, {
      isMissionSession: task.type === 'adhoc' && task.parentTaskId !== null,
    });
    const toolSet = Object.fromEntries(
      toolDefs.map((def) => [
        def.name,
        { description: def.description, inputSchema: def.inputSchema },
      ]),
    );
    const forcedArtifact = state.step === 0 ? artifactIntent : undefined;
    if (forcedArtifact && !toolDefs.some((tool) => tool.name === forcedArtifact.toolName)) {
      const text = artifactToolUnavailable(forcedArtifact);
      window.push({ role: 'assistant', content: text } as ModelMessage);
      return stageFinalResponse(deps, lease, state, window, {
        text,
        progress: text.slice(0, 200),
        terminalStatus: 'done',
        outcome: 'done',
      });
    }

    // An unattended goal session opens by acting, not by talking. Prose on the
    // first step is how these runs end up with nothing done, so the first step
    // must produce a tool call; later steps are free to conclude in prose once
    // there is a real result to report.
    const mustAct = !forcedArtifact && isUnattendedGoalSession(task) && state.step === 0;

    let stepResult = await router.step(role, {
      taskId: task.id,
      system,
      messages: window,
      tools: toolSet as never,
      toolChoice: forcedArtifact
        ? { type: 'tool', toolName: forcedArtifact.toolName }
        : mustRecordGoalProgress
          ? { type: 'tool', toolName: 'goals.update_progress' }
          : mustAct
            ? 'required'
            : undefined,
      // The primary chat model has intermittently timed out when a named tool
      // is mandatory. Use the role's configured tool-capable fallback. Goal
      // bookkeeping stays tightly bounded; artifact arguments may contain the
      // full document, sheet, or presentation and must not be truncated.
      forceFallback: Boolean(forcedArtifact || mustRecordGoalProgress),
      maxOutputTokens: mustRecordGoalProgress ? 256 : undefined,
      critical,
    });
    if (!(await renewTaskLease(db, lease))) return LOST_LEASE;

    // A provider is allowed to return prose despite a forced tool choice. Give
    // it one tightly constrained retry; never turn that prose into a claimed
    // artifact or dispatch unrelated calls on behalf of this direct request.
    if (
      stepResult.ok &&
      forcedArtifact &&
      needsArtifactToolRetry(forcedArtifact, stepResult.toolCalls)
    ) {
      console.warn('retrying missing required artifact tool call', {
        taskId: task.id,
        requiredTool: forcedArtifact.toolName,
      });
      stepResult = await router.step(role, {
        taskId: task.id,
        system: `${system}\n\nThis is an explicit artifact request. Call ${forcedArtifact.toolName} now. Do not answer with prose until that tool call has been emitted.`,
        messages: window,
        tools: toolSet as never,
        toolChoice: { type: 'tool', toolName: forcedArtifact.toolName },
        forceFallback: true,
        critical,
      });
      if (!(await renewTaskLease(db, lease))) return LOST_LEASE;

      if (stepResult.ok && needsArtifactToolRetry(forcedArtifact, stepResult.toolCalls)) {
        const text = artifactRoutingFailure(forcedArtifact);
        console.error('required artifact tool call was not emitted', {
          taskId: task.id,
          requiredTool: forcedArtifact.toolName,
        });
        window.push({ role: 'assistant', content: text } as ModelMessage);
        return stageFinalResponse(deps, lease, state, window, {
          text,
          progress: text.slice(0, 200),
          terminalStatus: 'failed',
          outcome: 'failed',
        });
      }
    }

    // Named tool choice is advisory for some providers. A verified goal step
    // must not finish in prose while leaving the goal's durable progress stale.
    if (
      stepResult.ok &&
      mustRecordGoalProgress &&
      needsGoalProgressToolRetry(stepResult.toolCalls)
    ) {
      console.warn('retrying missing required goal progress tool call', { taskId: task.id });
      stepResult = await router.step(role, {
        taskId: task.id,
        system: `${system}\n\nCall goals.update_progress now. Use only the completed tool evidence, and do not answer with prose until that tool call has been emitted.`,
        messages: window,
        tools: toolSet as never,
        toolChoice: { type: 'tool', toolName: 'goals.update_progress' },
        forceFallback: true,
        maxOutputTokens: 256,
        critical,
      });
      if (!(await renewTaskLease(db, lease))) return LOST_LEASE;

      if (stepResult.ok && needsGoalProgressToolRetry(stepResult.toolCalls)) {
        return stopForUnsavedGoalProgress(
          deps,
          lease,
          state,
          window,
          'the model did not emit goals.update_progress after a constrained retry',
        );
      }
    }

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
      await notifyOwnerAndConversation(
        deps,
        task,
        `I hit this task's own budget cap (${stepResult.decision.reason}) and stopped. It's marked needs-attention on the Tasks page — raise the task budget there if you want me to finish.`,
      );
      return { outcome: 'needs_attention', detail: stepResult.decision.reason };
    }

    if (forcedArtifact) {
      // A forced creation request authorizes only its matching tool. This is
      // defense in depth in case a provider emits additional calls anyway.
      const requiredCall = stepResult.toolCalls.find(
        (toolCall) => toolCall.toolName === forcedArtifact.toolName,
      );
      if (requiredCall) stepResult = { ...stepResult, toolCalls: [requiredCall] };
    }
    if (mustRecordGoalProgress) {
      // A forced progress turn authorizes only the required bookkeeping write.
      // Dropping provider-added calls also makes the durable-success check below
      // unambiguous: this turn either saved progress or stops for owner attention.
      const requiredCall = stepResult.toolCalls.find(
        (toolCall) => toolCall.toolName === 'goals.update_progress',
      );
      if (requiredCall) stepResult = { ...stepResult, toolCalls: [requiredCall] };
    }

    // 'length' means the model was cut off at the token budget. With no tool
    // calls we still hold a (possibly truncated) text answer that is far better
    // to deliver than to fail the whole turn on — this is the last-line guard
    // for reasoning models that spend their budget thinking. Truncated tool
    // arguments, by contrast, are unsafe to dispatch, so a cut-off mid-tool-call
    // stays a hard failure.
    const cutOffWithText =
      stepResult.finishReason === 'length' && stepResult.toolCalls.length === 0;
    // A completed answer with no tool calls is safe to deliver whatever label the
    // provider attaches to the finish. Some providers surface 'other'/'unknown'/
    // 'content-filter' even when the model returned a usable message. Discarding
    // it throws, and because the finish reason is deterministic for that provider
    // the whole task retries into the same failure and dead-letters — the turn
    // "keeps failing" with nothing delivered. Only an empty response or a finish
    // that left tool calls in an unknown (truncated) state is a hard failure.
    const completedTextAnswer =
      stepResult.toolCalls.length === 0 && stepResult.text.trim().length > 0;
    const successfulFinish =
      stepResult.finishReason === undefined ||
      stepResult.finishReason === 'stop' ||
      (stepResult.toolCalls.length > 0 && stepResult.finishReason === 'tool-calls') ||
      cutOffWithText ||
      completedTextAnswer;
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
      const approvalNotices: Array<{
        taskId: string;
        approvalId: string;
        shortCode: string;
        summary: string;
      }> = [];
      let requiredGoalProgressSaved = !mustRecordGoalProgress;
      let requiredGoalProgressFailure = 'the progress tool was not dispatched';
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
              callbackTokenHash: hashCallbackToken(outcome.result.callbackToken),
              timeoutAt: outcome.result.timeoutAt,
            };
            if (tc.toolName === 'goals.update_progress') {
              requiredGoalProgressFailure = 'the progress write returned an unfinished job';
            }
          } else {
            window.push(toolResultMessage(tc.toolCallId, tc.toolName, outcome.result));
            state.completedToolCallIds.push(outcome.toolCallId);
            if (tc.toolName === 'goals.update_progress') requiredGoalProgressSaved = true;
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
            approvalId: outcome.approvalId,
            shortCode: outcome.shortCode,
            summary: outcome.summary,
          });
          if (tc.toolName === 'goals.update_progress') {
            requiredGoalProgressFailure = 'the progress write unexpectedly required approval';
          }
        } else {
          window.push(toolResultMessage(tc.toolCallId, tc.toolName, { error: outcome.reason }));
          if (tc.toolName === 'goals.update_progress') {
            requiredGoalProgressFailure = outcome.reason;
          }
        }
      }

      if (!requiredGoalProgressSaved) {
        return stopForUnsavedGoalProgress(deps, lease, state, window, requiredGoalProgressFailure);
      }

      window = compact(window);
      state.contextWindow = window as unknown as TaskState['contextWindow'];

      if (pendingApprovals.length > 0) {
        const parked = await parkForApproval(db, lease, state, pendingApprovals);
        if (!parked) return LOST_LEASE;
        if (deps.notifyApproval && approvalNotices.length > 0) {
          await deps
            .notifyApproval(task, approvalNotices)
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
          approvalNotices.map((notice) => ({
            type: 'approval',
            approvalId: notice.approvalId,
            shortCode: notice.shortCode,
            summary: notice.summary,
          })),
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
    return stageModelFinalResponse(
      deps,
      lease,
      state,
      window,
      {
        text,
        progress: text.slice(0, 200),
        terminalStatus: 'done',
        outcome: 'done',
      },
      artifactIntent,
    );
  }

  // max steps exhausted
  const stuck = `stopped after ${task.maxSteps} steps without finishing`;
  const stuckMessage = `I ${stuck}. Here's where I got: ${state.scratchpad || 'see task log.'}`;
  if (isUnattendedGoalSession(task)) {
    const goalToolEvidence = await db
      .select({
        toolName: toolCalls.toolName,
        status: toolCalls.status,
        result: toolCalls.result,
        step: toolCalls.step,
      })
      .from(toolCalls)
      .where(eq(toolCalls.taskId, task.id));
    if (needsGoalProgressUpdate(goalToolEvidence)) {
      return stopForUnsavedGoalProgress(
        deps,
        lease,
        state,
        window,
        'the final work step exhausted the task before a later progress turn',
      );
    }
    if (!goalToolEvidence.some(isGoalWorkEvidence)) {
      if (task.goalId) await recordGoalBlocked(db, task.goalId, stuckMessage);
      await notifyOwnerAndConversation(
        deps,
        task,
        `This goal's automatic session exhausted its work limit without a verified result and needs attention: ${stuckMessage}`,
      );
      window.push({ role: 'assistant', content: stuckMessage } as ModelMessage);
      return stageFinalResponse(deps, lease, state, window, {
        text: stuckMessage,
        progress: stuck,
        terminalStatus: 'needs_attention',
        outcome: 'needs_attention',
      });
    }
  }
  window.push({ role: 'assistant', content: stuckMessage } as ModelMessage);
  return stageFinalResponse(deps, lease, state, window, {
    text: stuckMessage,
    progress: stuck,
    terminalStatus: 'failed',
    outcome: 'failed',
  });
}
