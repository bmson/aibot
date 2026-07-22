import { toolCalls } from '@assistant/db';
import type { ModelMessage } from 'ai';
import { eq } from 'drizzle-orm';
import { hashCallbackToken } from '../../browse.js';
import { buildSystemPrompt, PROMPT_VERSION } from '../../chat.js';
import { isJobPending } from '../../code-exec.js';
import { loadConfig } from '../../config.js';
import type { Plan, TaskState, Trust } from '../../events.js';
import { getAmbientBlock } from '../../memory/ambient.js';
import { getOwnerCard } from '../../memory/consolidation.js';
import { recallRelevantContext, recentWindowStart } from '../../memory/recall.js';
import { bumpSkillUse, recallSkills, renderSkillsBlock } from '../../memory/skills.js';
import { markApprovalsNotified } from '../approvals.js';
import {
  artifactRoutingFailure,
  artifactToolUnavailable,
  needsArtifactToolRetry,
} from '../artifact-intent.js';
import {
  isGoalWorkEvidence,
  needsGoalProgressToolRetry,
  needsGoalProgressUpdate,
} from '../goal-evidence.js';
import {
  checkpointTask,
  markTaskNeedsAttention,
  parkForApproval,
  parkForBudget,
  renewTaskLease,
  sleepTask,
} from '../machine.js';
import { PLANNER_VERSION } from '../planner.js';
import { isSimulatedApprovalNotice } from '../response-contract.js';
import { budgetResumeAt, channelContext, isUnattendedGoalSession } from './context-helpers.js';
import {
  SCHEDULE_DIRECTIVE,
  stageFinalResponse,
  stageModelFinalResponse,
  stopForUnsavedGoalProgress,
} from './finalize.js';
import {
  notifyOwnerAndConversation,
  postConversationNotice,
  recordGoalBlocked,
  taskBudgetPermissionRequest,
} from './notices.js';
import type { RunContext } from './phases.js';
import { roleForTask } from './role.js';
import { type ExecuteResult, LOST_LEASE } from './types.js';
import { compact, toolResultMessage } from './util.js';

/**
 * The model step loop: build the system prompt, let the model propose tool
 * calls, dispatch them through the risk gate, checkpoint each step, and
 * park / sleep / complete. Runs after planning; the pre-loop resume and
 * direct-intent phases have already settled in phases.ts.
 */
export async function runStepLoop(rc: RunContext, plan: Plan | null): Promise<ExecuteResult> {
  const { deps, db, router, dispatcher, task, agent, state, ctx, artifactIntent } = rc;
  const lease = task;
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

  // Ambient "right now" context (Phase 25): the fused location + weather block
  // (falls back to location-only when the snapshot is stale). Owner-private and
  // transient, so it mirrors the owner-card gate.
  let ambientBlock: string | undefined;
  if (privilegedTask && !state.untrustedContext) {
    try {
      ambientBlock = await getAmbientBlock(db, agent.id);
    } catch (err) {
      console.error('ambient lookup failed — continuing without it', err);
    }
  }

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
    const lastUser = [...rc.window].reverse().find((m) => m.role === 'user');
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

  // Skill library (Phase 26): retrieve learned procedures relevant to this task
  // as ADVICE (never auto-run). Owner-private, mirrors the owner-card gate;
  // fetched once and reused across loop iterations — the library is task-stable.
  let skillsBlock: string | undefined;
  if (privilegedTask && !state.untrustedContext) {
    const lastUser = [...rc.window].reverse().find((m) => m.role === 'user');
    const skillQuery = [
      plan?.reasoning,
      typeof lastUser?.content === 'string' ? lastUser.content : '',
    ]
      .filter(Boolean)
      .join(' ')
      .trim();
    if (skillQuery) {
      try {
        const found = await recallSkills(db, router, agent.id, skillQuery, { taskId: task.id });
        if (found.length > 0) {
          skillsBlock = renderSkillsBlock(found);
          await bumpSkillUse(
            db,
            found.map((s) => s.id),
          );
        }
      } catch (err) {
        console.error('skill recall failed — continuing without it', err);
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
        skills: !state.untrustedContext ? skillsBlock : undefined,
        ambient: !state.untrustedContext ? ambientBlock : undefined,
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
      rc.window.push({ role: 'assistant', content: text } as ModelMessage);
      return stageFinalResponse(deps, lease, state, rc.window, {
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
      messages: rc.window,
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
        messages: rc.window,
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
        rc.window.push({ role: 'assistant', content: text } as ModelMessage);
        return stageFinalResponse(deps, lease, state, rc.window, {
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
        messages: rc.window,
        tools: toolSet as never,
        toolChoice: { type: 'tool', toolName: 'goals.update_progress' },
        // The primary provider already ignored this exact named-tool request.
        // A second attempt on the same route just repeats that failure. Goal
        // bookkeeping is schema-bounded and simple, so use the configured
        // fallback to give the task an independent way to save its checkpoint.
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
          rc.window,
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
        messages: rc.window,
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
        state.contextWindow = compact(rc.window) as unknown as TaskState['contextWindow'];
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
      const budgetRequest = taskBudgetPermissionRequest(task, stepResult.decision.reason);
      await notifyOwnerAndConversation(deps, task, budgetRequest.text, [budgetRequest.part]);
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

    // assistant turn (text and/or tool calls) into the rc.window
    if (stepResult.toolCalls.length > 0) {
      rc.window.push({
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
          rc.window.push(
            toolResultMessage(tc.toolCallId, tc.toolName, {
              error:
                'a browser job is already running for this task — wait for its result before making more tool calls',
            }),
          );
          continue;
        }
        if (!(await renewTaskLease(db, lease))) return LOST_LEASE;
        rc.browserStageRemainder = stepResult.toolCalls.slice(toolIndex + 1);
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
        rc.browserStageRemainder = [];

        if (outcome.kind === 'executed') {
          if (isJobPending(outcome.result)) {
            // Leave this tool call unmatched while the task sleeps. The
            // callback's terminal output will be its one result before the
            // transcript is sent to the model again.
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
            rc.window.push(toolResultMessage(tc.toolCallId, tc.toolName, outcome.result));
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
          rc.window.push(
            toolResultMessage(tc.toolCallId, tc.toolName, {
              deferred: true,
              reason: outcome.reason,
              note: 'budget exhausted — the task is parked and will retry this action when the budget resets',
            }),
          );
          state.contextWindow = compact(rc.window) as unknown as TaskState['contextWindow'];
          const parked = await parkForBudget(db, lease, state, outcome.resumeAt);
          if (!parked) return LOST_LEASE;
          await postConversationNotice(
            db,
            task,
            `I'm pausing here — this action doesn't fit the remaining budget (${outcome.reason}). The task resumes automatically when the budget resets; you can also raise the caps on the Costs page.`,
          );
          return { outcome: 'parked', detail: outcome.reason };
        } else if (outcome.kind === 'awaiting_approval') {
          // Approval is runtime state, not a tool result. The approved,
          // denied, or expired terminal outcome is stitched in on resume.
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
          rc.window.push(toolResultMessage(tc.toolCallId, tc.toolName, { error: outcome.reason }));
          if (tc.toolName === 'goals.update_progress') {
            requiredGoalProgressFailure = outcome.reason;
          }
        }
      }

      if (!requiredGoalProgressSaved) {
        return stopForUnsavedGoalProgress(
          deps,
          lease,
          state,
          rc.window,
          requiredGoalProgressFailure,
        );
      }

      rc.window = compact(rc.window);
      state.contextWindow = rc.window as unknown as TaskState['contextWindow'];

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
    rc.window.push({ role: 'assistant', content: text } as ModelMessage);
    return stageModelFinalResponse(
      deps,
      lease,
      state,
      rc.window,
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
        rc.window,
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
      rc.window.push({ role: 'assistant', content: stuckMessage } as ModelMessage);
      return stageFinalResponse(deps, lease, state, rc.window, {
        text: stuckMessage,
        progress: stuck,
        terminalStatus: 'needs_attention',
        outcome: 'needs_attention',
      });
    }
  }
  rc.window.push({ role: 'assistant', content: stuckMessage } as ModelMessage);
  return stageFinalResponse(deps, lease, state, rc.window, {
    text: stuckMessage,
    progress: stuck,
    terminalStatus: 'failed',
    outcome: 'failed',
  });
}
