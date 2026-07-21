import type { TaskRow } from '@assistant/db';
import { tasks, toolCalls } from '@assistant/db';
import type { ModelMessage } from 'ai';
import { eq } from 'drizzle-orm';
import { hashCallbackToken, isBrowserJobPending } from '../browse.js';
import { buildSystemPrompt, getAgent, PROMPT_VERSION } from '../chat.js';
import { loadConfig } from '../config.js';
import { BudgetReservationError } from '../cost.js';
import type { TaskState, Trust } from '../events.js';
import { getOwnerCard } from '../memory/consolidation.js';
import { recallRelevantContext, recentWindowStart } from '../memory/recall.js';
import type { ProposedToolCall } from '../model-router/router.js';
import { withSpan } from '../otel.js';
import { markApprovalsNotified } from './approvals.js';
import {
  artifactRoutingFailure,
  artifactToolUnavailable,
  needsArtifactToolRetry,
  requestedArtifactIntent,
} from './artifact-intent.js';
import {
  budgetResumeAt,
  channelContext,
  isKnownSenderReplyTask,
  isUnattendedGoalSession,
} from './executor/context-helpers.js';
import {
  finalizePendingResponse,
  SCHEDULE_DIRECTIVE,
  stageFinalResponse,
  stageModelFinalResponse,
  stopForUnsavedGoalProgress,
} from './executor/finalize.js';
import { unreadSharedDocumentIntent } from './executor/intent.js';
import {
  notifyOwnerAndConversation,
  postConversationNotice,
  recordGoalBlocked,
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
import { roleForTask } from './executor/role.js';
import { seedContext } from './executor/seed.js';
import { createToolContext } from './executor/tool-context.js';
import { type ExecuteResult, type ExecutorDeps, LOST_LEASE } from './executor/types.js';
import { compact, latestUserText, toolResultMessage } from './executor/util.js';
import {
  isGoalWorkEvidence,
  needsGoalProgressToolRetry,
  needsGoalProgressUpdate,
} from './goal-evidence.js';
import {
  checkpointTask,
  claimTask,
  markTaskNeedsAttention,
  parkForApproval,
  parkForBudget,
  recordFailedAttempt,
  renewTaskLease,
  sleepTask,
  type TaskLease,
  taskState,
} from './machine.js';
import { PLANNER_VERSION } from './planner.js';
import { isSimulatedApprovalNotice } from './response-contract.js';

export { roleForTask } from './executor/role.js';
// Public API preserved: these symbols now live in ./executor/* modules but stay
// importable from './workflow/executor.js' (and thus '@assistant/core').
export type {
  DispatcherPort,
  ExecuteResult,
  ExecutorDeps,
  ToolContextLike,
} from './executor/types.js';
export { toolResultMessage } from './executor/util.js';

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
  let browserStageRemainder: ProposedToolCall[] = [];
  const browserStageSnapshots = new Map<
    string,
    { contextWindow: TaskState['contextWindow']; pendingJob: TaskState['pendingJob'] }
  >();

  const ctx = createToolContext({
    db,
    task,
    state,
    signal: abort.signal,
    getWindow: () => window,
    getBrowserStageRemainder: () => browserStageRemainder,
    browserStageSnapshots,
  });

  const rc: RunContext = {
    deps,
    db,
    router,
    dispatcher,
    task,
    agent,
    state,
    ctx,
    window,
    artifactIntent,
    documentReadIntent,
  };

  // ── Resume: settle a finished (or timed-out) browser job, then approvals ───
  await resumePendingJob(rc);
  const approvalsResult = await resumePendingApprovals(rc);
  if (approvalsResult) return approvalsResult;

  // A browser job is (still) in flight — sleep until its callback or timeout.
  if (state.pendingJob) {
    state.contextWindow = compact(window) as unknown as TaskState['contextWindow'];
    const slept = await sleepTask(db, lease, state, new Date(state.pendingJob.timeoutAt));
    if (!slept) return LOST_LEASE;
    return { outcome: 'sleeping', detail: 'browser job running' };
  }

  // Read an owner-supplied shared document (step 0) before the model continues.
  const documentReadResult = await runDirectDocumentRead(rc);
  if (documentReadResult) return documentReadResult;

  const planResult = await runPlanPhase(rc);
  if ('outcome' in planResult) return planResult;
  const plan = planResult.plan;

  // Route action requests to the reasoning model (see roleForTask): a goal
  // session, a mission, an email to triage, or a chat/SMS turn the planner
  // routed to real work all drive tools on the strong model. The draft model
  // answers these with plausible prose and no tool calls — how a request can
  // look handled while nothing happened.
  const role = roleForTask(task, plan);
  // Forced-named-tool retries drop to the role's fallback because the DRAFT
  // primary (deepseek) intermittently times out when a tool is mandatory. The
  // reasoning primary (Claude) has no such issue, and its fallback is the
  // WEAKER draft model — so on a reason task, forcing the fallback is a pure
  // downgrade. Keep the fallback only for draft; a hard task on reason stays on
  // the strong model through its retries (the missing escalation path, E2).
  const useForcedToolFallback = role !== 'reason';
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

    // Open by acting, not talking, when the work is settled. An unattended goal
    // session and any turn the planner routed to a 'workflow' (multi-step work
    // executable now) must produce a tool call on the first step; later steps
    // are free to conclude in prose once there is a real result. This closes the
    // "forwarded/action request makes zero tool calls" path on the email/chat
    // side the goal path was already hardened against. A 'reply'/'clarify' plan
    // is intentionally excluded — those legitimately answer in prose.
    const mustAct =
      !forcedArtifact &&
      state.step === 0 &&
      (isUnattendedGoalSession(task) || plan?.action === 'workflow');

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
      forceFallback: useForcedToolFallback && Boolean(forcedArtifact || mustRecordGoalProgress),
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
        forceFallback: useForcedToolFallback,
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
        forceFallback: useForcedToolFallback,
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

    // Approval cards and codes are runtime records, never prose generated by
    // the model. If it mimics an earlier approval notice without a tool call,
    // give it one constrained chance to emit the real gated action instead of
    // publishing a phantom code that cannot exist on the Approvals page.
    if (
      stepResult.ok &&
      stepResult.toolCalls.length === 0 &&
      isSimulatedApprovalNotice(stepResult.text)
    ) {
      console.warn('retrying simulated approval notice without a tool call', { taskId: task.id });
      stepResult = await router.step(role, {
        taskId: task.id,
        system: `${system}\n\nYou claimed an approval exists, but no tool call created it. Emit the actual gated tool call now. Never write an approval code or approval-page notice yourself; the runtime creates those after the tool call.`,
        messages: window,
        tools: toolSet as never,
        toolChoice: 'required',
        forceFallback: useForcedToolFallback,
        critical,
      });
      if (!(await renewTaskLease(db, lease))) return LOST_LEASE;
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
        toolName: string;
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
            toolName: tc.toolName,
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
        let ownerNotified = false;
        if (deps.notifyApproval && approvalNotices.length > 0) {
          ownerNotified = await deps
            .notifyApproval(task, approvalNotices)
            .then(() => true)
            .catch((err) => {
              console.error('approval notification failed', err);
              return false;
            });
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
        await markApprovalsNotified(
          db,
          approvalNotices.map((notice) => notice.approvalId),
          ownerNotified ? ['owner', 'conversation'] : ['conversation'],
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
