import type { Db, TaskRow } from '@assistant/db';
import { messages, tasks, toolCalls } from '@assistant/db';
import type { ModelMessage } from 'ai';
import { and, eq, inArray, ne } from 'drizzle-orm';
import {
  assistantMessageParts,
  getOrCreateNotificationsConversation,
  persistMessage,
} from '../../chat.js';
import type { PendingFinal, TaskState } from '../../events.js';
import type { RecallSource } from '../../memory/recall.js';
import { type ArtifactIntent, artifactExecutionFailure } from '../artifact-intent.js';
import { isGoalWorkEvidence } from '../goal-evidence.js';
import {
  checkpointTask,
  completeTask,
  enqueueTask,
  markAttentionNotified,
  markTaskNeedsAttention,
  renewTaskLease,
  type TaskLease,
  taskState,
} from '../machine.js';
import { type ActionEvidence, enforceResponseContract } from '../response-contract.js';
import { isUnattendedGoalSession, KNOWN_SENDER_REPLY_KIND } from './context-helpers.js';
import { notifyOwnerAndConversation, recordGoalBlocked } from './notices.js';
import { type ExecuteResult, type ExecutorDeps, LOST_LEASE } from './types.js';
import { compact } from './util.js';

/**
 * Deferred work is only real once a durable row exists. Left to prose the
 * model answers "I'll keep updating it as I go" — a promise nothing in the
 * system will keep, and which the response contract then has to blank out.
 */
export const SCHEDULE_DIRECTIVE =
  '\nThis turn defers work to the future. Before you finish, call task.schedule with a concrete time and a self-contained instruction (or mission.update if this belongs to a mission). Do not promise to continue, watch, or keep updating anything unless that call succeeded — if you cannot schedule it, say so plainly and do the part you can do now.';

const EVIDENCE_COLUMNS = {
  toolName: toolCalls.toolName,
  status: toolCalls.status,
  result: toolCalls.result,
  error: toolCalls.error,
} as const;

export async function stopForUnsavedGoalProgress(
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

/**
 * A retry must not duplicate the dashboard/chat copy of a final response.
 *
 * A conversation-less assistant-trust task (a scheduled/goalless automation)
 * would otherwise deliver its answer NOWHERE — deliverFinal no-ops for non-owner
 * trust and there is no thread to write into. Route those into the assistant's
 * Notifications thread so the owner always sees the result on the dashboard.
 */
async function persistFinalConversationOnce(
  db: Db,
  task: TaskRow,
  text: string,
  recall?: RecallSource[],
): Promise<boolean> {
  let conversationId = task.conversationId;
  let body = text;
  if (!conversationId) {
    if (task.trust !== 'assistant' || !text.trim()) return false;
    conversationId = await getOrCreateNotificationsConversation(db, task.agentId);
    // The Notifications thread mixes many tasks — title the entry so the owner
    // can tell what produced it.
    const title = task.title?.trim() || 'Scheduled task';
    body = `**${title}**\n\n${text}`;
  }
  const [existing] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.taskId, task.id),
        eq(messages.role, 'assistant'),
        eq(messages.origin, 'assistant'),
        eq(messages.text, body),
      ),
    )
    .limit(1);
  // A duplicate from an earlier attempt still means an owner-visible copy exists.
  if (existing) return true;
  await persistMessage(db, {
    conversationId,
    taskId: task.id,
    role: 'assistant',
    origin: 'assistant',
    parts: assistantMessageParts(body, recall),
    text: body,
  });
  return true;
}

/** Deliver a previously checkpointed final response, then finish under CAS. */
export async function finalizePendingResponse(
  deps: ExecutorDeps,
  task: TaskLease,
  pending: PendingFinal,
  checkpointState?: TaskState,
): Promise<ExecuteResult> {
  if (!(await renewTaskLease(deps.db, task))) return LOST_LEASE;
  const recallSources = (checkpointState ?? taskState(task)).recall ?? undefined;
  const conversationDelivered = await persistFinalConversationOnce(
    deps.db,
    task,
    pending.text,
    recallSources,
  );

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
  // A needs_attention final that reached an owner-visible thread (the task's own
  // conversation or the Notifications sink) is already notified — stamp it so the
  // re-notify sweep leaves it alone. If it delivered nowhere, leave it unstamped
  // so the sweep keeps trying.
  if (pending.terminalStatus === 'needs_attention' && conversationDelivered) {
    await markAttentionNotified(deps.db, task.id).catch((err) =>
      console.error('attention stamp failed', err),
    );
  }
  return { outcome: pending.outcome, detail: pending.progress.slice(0, 200) };
}

/** Persist-before-send turns the task checkpoint into a small durable outbox. */
export async function stageFinalResponse(
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
 *
 * Two scopes: this task's rows decide whether *this* attempt succeeded, and
 * earlier rows from the same conversation let the contract recognise
 * artifacts that genuinely exist. Without the second scope, referring back to
 * a doc built two turns ago was answered with "I have not created anything
 * outside this chat" — a flat falsehood with the doc sitting in Drive. The
 * response contract still refuses to let prior-turn rows authorise a new
 * send, submission, or booking.
 */
export async function stageModelFinalResponse(
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
  // Corpus for the URL-provenance rule: every tool result (both scopes), the
  // trigger, and the owner/tool turns — but NOT the assistant's own final, which
  // is already in the window and must not evidence its own fabricated link.
  const urlCorpus = [
    JSON.stringify(evidence),
    JSON.stringify(task.trigger ?? {}),
    window
      .filter((m) => m.role === 'user' || m.role === 'tool')
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n'),
  ].join('\n');
  const checked = enforceResponseContract(pending.text, evidence, { urlCorpus });
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
  // A known contact's plain answer would otherwise dead-end in the dashboard;
  // propose it back to them (owner-approved) so the thread does not go silent.
  await maybeEnqueueKnownSenderReply(deps, task, text);
  return stageFinalResponse(deps, task, state, window, {
    ...pending,
    text,
    progress: text.slice(0, 200),
  });
}

/**
 * D9 — close the known-sender email dead-end.
 *
 * A KNOWN contact (an authenticated, non-owner sender) whose email_triage task
 * ends in a plain answer or a clarify question gets NOTHING back: deliverEmailFinal
 * auto-sends only to the owner, so the drafted reply lands solely in the dashboard
 * and the sender's thread goes silent. When the triage model itself took no
 * outbound action (no gmail.send / gmail.create_draft row), deterministically
 * enqueue an assistant-trust adhoc child that PROPOSES exactly that reply via
 * gmail.send. Because gmail.send is risk:'approval', the owner sees the approval
 * card and approves or denies — nothing is ever auto-sent to a third party. The
 * child is stamped taintedOrigin (S1): the draft derives from the sender's own
 * message, so the child runs tainted and every outward call stays gated.
 *
 * Unknown senders are unchanged (dashboard only). Idempotent on externalEventId:
 * a finalization retry never enqueues a duplicate child.
 */
export async function maybeEnqueueKnownSenderReply(
  deps: ExecutorDeps,
  task: TaskRow,
  draft: string,
): Promise<void> {
  const conversationId = task.conversationId;
  if (task.type !== 'email_triage' || task.trust !== 'known' || !conversationId) return;
  const reply = draft.trim();
  if (!reply) return;

  const payload = (task.trigger as { payload?: Record<string, unknown> } | null)?.payload ?? {};
  const asStr = (v: unknown) => (typeof v === 'string' ? v : '');
  const to = asStr(payload.from);
  const threadId = asStr(payload.threadId);
  // Without an authenticated recipient and a thread to reply on there is nothing
  // to send; leave the answer in the dashboard as before.
  if (!to || !threadId) return;
  const subject = asStr(payload.subject);
  const rfcMessageId = asStr(payload.rfcMessageId);

  // If the triage model already drafted or sent a reply of its own, a reply path
  // exists — do not propose a second one. (gmail.send parks for approval before
  // it could reach this finalization, but a resumed-and-sent call leaves a row.)
  const [outbound] = await deps.db
    .select({ id: toolCalls.id })
    .from(toolCalls)
    .where(
      and(
        eq(toolCalls.taskId, task.id),
        inArray(toolCalls.toolName, ['gmail.send', 'gmail.create_draft']),
      ),
    )
    .limit(1);
  if (outbound) return;

  const replySubject = /^re:/i.test(subject) ? subject : `Re: ${subject || '(no subject)'}`;
  const instruction = [
    `A known contact (${to}) emailed you, and this reply has been drafted for them.`,
    `Send it now by calling gmail.send exactly once with to: ["${to}"], subject: ${JSON.stringify(
      replySubject,
    )}, threadId: "${threadId}", and body set to the draft below VERBATIM.`,
    'Do not rewrite, shorten, translate, or add to the draft, and do not call any other tool. gmail.send always requires the owner to approve the exact message before anything is sent.',
    '',
    'Draft to send:',
    reply,
  ].join('\n');

  await enqueueTask(deps.db, {
    event: {
      source: 'internal',
      externalEventId: `known-sender-reply:${task.id}`,
      agentId: task.agentId,
      conversationId,
      trust: 'assistant',
      payload: {
        kind: KNOWN_SENDER_REPLY_KIND,
        to,
        threadId,
        subject: replySubject,
        rfcMessageId,
        draft: reply,
        instruction,
        // External provenance carried forward so the child runs tainted and any
        // outward call it makes stays approval-gated.
        taintedOrigin: true,
      },
    },
    type: 'adhoc',
    parentTaskId: task.id,
    // Fixed next action: send the drafted reply. A pre-set plan skips planning so
    // the executor forces the tool call on step 0 (mustAct) rather than leaving
    // it to the planner.
    plan: {
      action: 'workflow',
      reasoning: 'Propose the drafted reply to the known sender for owner approval',
      steps: ['Send the drafted reply via gmail.send (owner-approved)'],
      missingInfo: [],
    },
    maxSteps: 4,
  });
}
