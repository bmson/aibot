import type { TaskRow } from '@assistant/db';
import { tasks } from '@assistant/db';
import type { ModelMessage } from 'ai';
import { eq } from 'drizzle-orm';
import { getAgent } from '../chat.js';
import { BudgetReservationError } from '../cost.js';
import type { TaskState } from '../events.js';
import { withSpan } from '../otel.js';
import { requestedArtifactIntent } from './artifact-intent.js';
import { isKnownSenderReplyTask } from './executor/context-helpers.js';
import { finalizePendingResponse } from './executor/finalize.js';
import { unreadSharedDocumentIntent } from './executor/intent.js';
import {
  notifyAttention,
  postConversationNotice,
  taskBudgetPermissionRequest,
} from './executor/notices.js';
import {
  type RunContext,
  resumePendingApprovals,
  resumePendingJob,
  runCodeJobPhase,
  runDirectDocumentRead,
  runMissionPhase,
  runPlanPhase,
} from './executor/phases.js';
import { foldOwnerRepliesSincePark, seedContext } from './executor/seed.js';
import { runStepLoop } from './executor/step-loop.js';
import { createToolContext } from './executor/tool-context.js';
import {
  type ExecuteResult,
  type ExecutorDeps,
  LOST_LEASE,
  type ToolContextLike,
} from './executor/types.js';
import { compact, latestUserText } from './executor/util.js';
import {
  claimTask,
  markTaskNeedsAttention,
  parkForBudget,
  recordFailedAttempt,
  sleepTask,
  type TaskLease,
  taskState,
} from './machine.js';

export { roleForTask } from './executor/role.js';
// Public API preserved: these symbols now live in ./executor/* modules but stay
// importable from './workflow/executor.js' (and thus '@assistant/core').
export type {
  DispatcherPort,
  ExecuteResult,
  ExecutorDeps,
  ToolContextLike,
} from './executor/types.js';
export { replaceToolResultMessage, toolResultMessage } from './executor/util.js';

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
          const budgetRequest = taskBudgetPermissionRequest(task, err.message);
          await notifyAttention(deps, task, budgetRequest.text, [budgetRequest.part]);
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
        // notifyAttention stamps the row so the re-notify sweep won't repeat it,
        // and leaves it unstamped (sweep-eligible) if this notify itself failed.
        await notifyAttention(
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
    payload?: { quotesExternalContent?: unknown; taintedOrigin?: unknown };
  } | null;
  // A task scheduled from a tainted session carries its provenance forward
  // (task.schedule stamps taintedOrigin). Without this a laundered instruction
  // would run in a clean context with autonomous network egress.
  if (trigger?.payload?.taintedOrigin === true) return true;
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

  // Code jobs (nightly extraction/consolidation, imports) run a registered
  // function, and missions run a deadline/reflection wake — both instead of the
  // model step loop.
  const codeJobResult = await runCodeJobPhase(deps, lease);
  if (codeJobResult) return codeJobResult;
  const missionResult = await runMissionPhase(deps, lease, agent);
  if (missionResult) return missionResult;

  let window = state.contextWindow as unknown as ModelMessage[];
  if (window.length === 0) {
    window = await seedContext(db, task);
    // Publish the seeded window into state BEFORE building the tool context, so
    // harvestKnownAddresses (which scans state.contextWindow) sees the thread's
    // real recipients on the FIRST run — not just on resume. Without this, the
    // recipient-provenance whitelist was empty on run 1, so a send to an address
    // named in the seeded thread flagged as unverified, yet the identical send on
    // a later resume (window now checkpointed) passed — same request, different
    // gating by run number.
    state.contextWindow = window as unknown as TaskState['contextWindow'];
  }
  // A direct document/sheet/slides request skips the generic planner, then forces
  // the matching creation tool. The D9 known-sender reply child is exempt: its
  // instruction embeds the sender's own draft, whose free text could otherwise
  // trip the artifact/doc-URL heuristics and force docs.create over gmail.send.
  const isKnownReply = isKnownSenderReplyTask(task);
  const artifactIntent =
    state.step === 0 && !isKnownReply
      ? requestedArtifactIntent(latestUserText(window) ?? '')
      : undefined;
  const documentReadIntent =
    state.step === 0 && !artifactIntent && !isKnownReply
      ? await unreadSharedDocumentIntent(db, task, window)
      : undefined;
  const browserStageSnapshots = new Map<
    string,
    { contextWindow: TaskState['contextWindow']; pendingJob: TaskState['pendingJob'] }
  >();

  // rc holds the shared, mutable run state. ctx's browser-staging closures read
  // the LIVE window / stage-remainder through rc, so it is built after rc and the
  // step loop reassigns rc.window (compaction) without stale captures.
  const rc: RunContext = {
    deps,
    db,
    router,
    dispatcher,
    task,
    agent,
    state,
    ctx: undefined as unknown as ToolContextLike,
    window,
    browserStageRemainder: [],
    artifactIntent,
    documentReadIntent,
  };
  rc.ctx = createToolContext({
    db,
    task,
    state,
    signal: abort.signal,
    getWindow: () => rc.window,
    getBrowserStageRemainder: () => rc.browserStageRemainder,
    browserStageSnapshots,
  });

  // ── Resume: settle a finished (or timed-out) browser job, then approvals ───
  await resumePendingJob(rc);
  const approvalsResult = await resumePendingApprovals(rc);
  if (approvalsResult) return approvalsResult;

  // A browser job is (still) in flight — sleep until its callback or timeout.
  if (state.pendingJob) {
    state.contextWindow = compact(rc.window) as unknown as TaskState['contextWindow'];
    const slept = await sleepTask(db, lease, state, new Date(state.pendingJob.timeoutAt));
    if (!slept) return LOST_LEASE;
    return { outcome: 'sleeping', detail: 'browser job running' };
  }

  // Fold any owner correction typed while this task was parked into the window,
  // so a resumed task acts on the latest owner intent, not a stale checkpoint.
  // (First run just baselines the watermark; chat channel only.)
  await foldOwnerRepliesSincePark(db, task, state, rc.window);

  // Read an owner-supplied shared document (step 0) before the model continues.
  const documentReadResult = await runDirectDocumentRead(rc);
  if (documentReadResult) return documentReadResult;

  const planResult = await runPlanPhase(rc);
  if ('outcome' in planResult) return planResult;
  return runStepLoop(rc, planResult.plan);
}
