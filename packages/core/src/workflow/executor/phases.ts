import type { AgentRow, Db } from '@assistant/db';
import { approvals, tasks, toolCalls } from '@assistant/db';
import type { ModelMessage } from 'ai';
import { eq, inArray } from 'drizzle-orm';
import { hashCallbackToken } from '../../browse.js';
import { PROMPT_VERSION } from '../../chat.js';
import { isJobPending } from '../../code-exec.js';
import { getRate, reconcileReservation } from '../../cost.js';
import { type Plan, PlanSchema, type TaskState } from '../../events.js';
import { codeJobName, runCodeJob } from '../../memory/jobs.js';
import type { ModelRouter, ProposedToolCall } from '../../model-router/router.js';
import { deliveredChannels, markApprovalsNotified } from '../approvals.js';
import {
  type ArtifactIntent,
  type DocumentReadIntent,
  documentReadDispatchFailure,
} from '../artifact-intent.js';
import {
  completeTask,
  parkForApproval,
  parkForBudget,
  renewTaskLease,
  sleepTask,
  type TaskLease,
  taskState,
} from '../machine.js';
import { startMission, wakeMission } from '../missions.js';
import { PLANNER_VERSION, planTask } from '../planner.js';
import { isUnattendedGoalSession } from './context-helpers.js';
import { maybeEnqueueKnownSenderReply, stageFinalResponse } from './finalize.js';
import {
  noticeParts,
  notifyOwnerAndConversation,
  postConversationNotice,
  recordGoalBlocked,
} from './notices.js';
import {
  type ExecuteResult,
  type ExecutorDeps,
  LOST_LEASE,
  type ToolContextLike,
} from './types.js';
import { compact, replaceToolResultMessage, toolResultMessage } from './util.js';

/**
 * Shared, mutable state threaded through the pre-step-loop phases of a task run.
 * `window` is a live array the phases push onto (never reassigned before the
 * step loop); `state`/`ctx` are shared objects whose mutations propagate.
 */
export interface RunContext {
  deps: ExecutorDeps;
  db: Db;
  router: ModelRouter;
  dispatcher: ExecutorDeps['dispatcher'];
  task: TaskLease;
  agent: AgentRow;
  state: TaskState;
  ctx: ToolContextLike;
  /** Live model-message window. Phases push onto it; the step loop reassigns it (compaction). */
  window: ModelMessage[];
  /** Calls queued after the one that launched a browser job (read by the staging closures). */
  browserStageRemainder: ProposedToolCall[];
  artifactIntent?: ArtifactIntent;
  documentReadIntent?: DocumentReadIntent;
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

/** Code jobs run a registered function instead of the model loop. Returns null when the task is not a code job. */
export async function runCodeJobPhase(
  deps: ExecutorDeps,
  task: TaskLease,
): Promise<ExecuteResult | null> {
  const { db, router } = deps;
  const lease = task;
  const job = codeJobName(task);
  if (job) {
    const outcome = await runCodeJob(
      {
        db,
        router,
        workspace: deps.workspace,
        documentProcessor: deps.documentProcessor,
        calendarReader: deps.calendarReader,
        jobUnavailable: deps.jobUnavailable,
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
  return null;
}

/** Missions never run the step loop themselves. Returns null when the task is not a mission. */
export async function runMissionPhase(
  deps: ExecutorDeps,
  task: TaskLease,
  agent: AgentRow,
): Promise<ExecuteResult | null> {
  const { db, router } = deps;
  if (task.type === 'mission') {
    const wake = await wakeMission({ db, router, notifyOwner: deps.notifyOwner }, task, agent);
    if (wake.action === 'lease_lost') return LOST_LEASE;
    return {
      outcome: wake.action === 'deadline_reached' ? 'done' : 'sleeping',
      detail: wake.action,
    };
  }
  return null;
}

/** Settle a finished (or timed-out) browser job before continuing the run. */
export async function resumePendingJob(rc: RunContext): Promise<void> {
  const { db, task, state, window, dispatcher, ctx } = rc;
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
      if (row && !isJobPending(row.result)) {
        return { kind: 'result' as const, row };
      }
      const timedOut = Date.now() >= new Date(pending.timeoutAt).getTime();
      if (row && !timedOut) return { kind: 'still_pending' as const };
      const failure = {
        ok: false,
        error: 'the background job never reported back (timed out) — treat this attempt as failed',
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
      replaceToolResultMessage(window, pending.toolCallId, pending.toolName, settled.row.result, {
        dbToolCallId: pending.dbToolCallId,
      });
      if (dispatcher.resultIsUntrusted(pending.toolName)) {
        state.untrustedContext = true;
        ctx.tainted = true;
      }
      state.completedToolCallIds.push(pending.dbToolCallId);
      state.pendingJob = null;
      await settleJobReservation(db, settled.row);
    } else if (settled.kind === 'timeout') {
      if (settled.row) await settleJobReservation(db, settled.row);
      replaceToolResultMessage(window, pending.toolCallId, pending.toolName, settled.failure);
      state.completedToolCallIds.push(pending.dbToolCallId);
      state.pendingJob = null;
    }
    // 'still_pending' (row present, sentinel intact, not yet timed out): leave
    // pendingJob set — the sleep-until-timeout below handles it, as before.
  }
}

/** Settle pending approvals. Returns a terminal result when the task parks/sleeps, else null. */
export async function resumePendingApprovals(rc: RunContext): Promise<ExecuteResult | null> {
  const { db, task, state, window, dispatcher, ctx } = rc;
  const lease = task;
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
      // Strict proposal order: once an earlier call in this batch is still
      // undecided, every later call waits too — a later-approved docs.share must
      // not execute before its docs.create is decided. Approvals proposed in one
      // model step usually stand alone, but ordering matters when they don't, and
      // the 24h approval expiry guarantees the batch eventually drains rather than
      // deadlocking on one un-actioned card.
      if (stillPending.length > 0) {
        stillPending.push(pending);
        continue;
      }
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
            noticeParts('parked'),
          );
          return { outcome: 'parked', detail: outcome.reason };
        }
        if (outcome.kind === 'executed' && isJobPending(outcome.result)) {
          // The approved call launched a background job. Do not add a
          // provisional tool result: the callback's terminal result must be the
          // one and only result paired with this model tool-call id.
          state.pendingJob = {
            dbToolCallId: pending.dbToolCallId,
            toolCallId: pending.toolCallId,
            toolName: pending.toolName,
            callbackTokenHash: hashCallbackToken(outcome.result.callbackToken),
            timeoutAt: outcome.result.timeoutAt,
          };
        } else {
          replaceToolResultMessage(
            window,
            pending.toolCallId,
            pending.toolName,
            outcome.kind === 'executed' ? outcome.result : { error: outcome.error },
          );
          state.completedToolCallIds.push(pending.dbToolCallId);
          if (outcome.kind === 'executed' && dispatcher.resultIsUntrusted(pending.toolName)) {
            state.untrustedContext = true;
            ctx.tainted = true;
          }
        }
      } else {
        replaceToolResultMessage(window, pending.toolCallId, pending.toolName, {
          denied: true,
          reason:
            approval.status === 'expired'
              ? 'approval expired before the owner responded'
              : 'the owner denied this action',
        });
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
  return null;
}

/** Read an owner-supplied shared document before the model continues. Returns a terminal result or null. */
export async function runDirectDocumentRead(rc: RunContext): Promise<ExecuteResult | null> {
  const { deps, db, task, state, window, ctx, dispatcher, documentReadIntent } = rc;
  const lease = task;
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
      // Card first, owner ping second — parkForApproval above already publishes
      // waiting_approval, so any delay between the two lets the chat poller see
      // a parked task whose approval card does not exist yet and stop listening.
      const conversationNotified = await postConversationNotice(
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
      let ownerNotified = false;
      if (deps.notifyApproval) {
        ownerNotified = await deps
          .notifyApproval(task, [
            {
              taskId: task.id,
              shortCode: outcome.shortCode,
              summary: outcome.summary,
              toolName: documentReadIntent.toolName,
            },
          ])
          .then(() => true)
          .catch((err) => {
            console.error('approval notification failed', err);
            return false;
          });
      }
      await markApprovalsNotified(
        db,
        [outcome.approvalId],
        deliveredChannels({ ownerNotified, conversationNotified }),
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
  return null;
}

/** Plan the task (unless a plan or artifact intent already exists). Returns a terminal result, or the resolved plan. */
export async function runPlanPhase(rc: RunContext): Promise<ExecuteResult | { plan: Plan | null }> {
  const { deps, db, router, task, agent, state, window, artifactIntent } = rc;
  const lease = task;
  let plan = task.plan ? PlanSchema.parse(task.plan) : null;
  if (!plan && !artifactIntent) {
    plan = await planTask({ db, router }, task, agent, window, {
      tainted: state.untrustedContext === true,
    });
    if (!(await renewTaskLease(db, lease))) return LOST_LEASE;
    // A forwarded or quoting owner email is tainted, and the planner often
    // summarizes it as a 'reply' instead of acting on the instruction inside the
    // forward — the recurring "forwarded action request does nothing" bug. Coerce
    // such a plan to 'workflow' so the step loop forces a step-0 tool call. This
    // is safe under taint: the dispatcher parks every outward action from a
    // tainted context for owner approval, so forcing a tool here can never act
    // autonomously — the worst case is a spurious approval card. 'clarify' is
    // left untouched so a genuinely ambiguous forward still asks.
    //
    // Owner-only by design. A known (non-owner) sender's email is the sender's
    // OWN message, not an owner instruction to act — coercing it into an action
    // would let a third party populate the owner's approval queue, and would
    // route the common "known contact asks a question" case (a prose answer,
    // zero tools) into A2's needs_attention park instead of D9, which already
    // proposes that reply for the owner to approve. Known senders stay on D9.
    if (
      plan?.action === 'reply' &&
      task.type === 'email_triage' &&
      task.trust === 'owner' &&
      state.untrustedContext === true
    ) {
      plan = { ...plan, action: 'workflow' };
    }
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
      // A known contact's clarify question would otherwise dead-end in the
      // dashboard; propose it back to them (owner-approved) so the thread lives.
      await maybeEnqueueKnownSenderReply(deps, task, question);
      return stageFinalResponse(deps, lease, state, window, {
        text: question,
        progress: 'asked for clarification',
        terminalStatus: 'done',
        outcome: 'clarify',
      });
    }
  }
  return { plan };
}
