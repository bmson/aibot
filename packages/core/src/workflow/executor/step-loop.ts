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
import type { StepCallOutcome } from '../../model-router/router.js';
import { deliveredChannels, markApprovalsNotified } from '../approvals.js';
import {
  artifactRoutingFailure,
  artifactToolUnavailable,
  needsArtifactToolRetry,
} from '../artifact-intent.js';
import {
  buildGoalProgressCheckpoint,
  isGoalWorkEvidence,
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
import {
  buildReadToolInput,
  detectPersonalReadRequest,
  groundReadToolInput,
  nextRequiredReadTool,
  type PersonalReadRequest,
  type ReadToolEvidence,
} from '../read-intent.js';
import { enforcePersonalReadResponse, isSimulatedApprovalNotice } from '../response-contract.js';
import {
  budgetResumeAt,
  channelContext,
  isMissionSessionTask,
  isUnattendedGoalSession,
} from './context-helpers.js';
import {
  SCHEDULE_DIRECTIVE,
  stageFinalResponse,
  stageModelFinalResponse,
  stopForUnsavedGoalProgress,
} from './finalize.js';
import {
  notifyAttention,
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
/**
 * The plan as prose. Raw JSON in a system prompt reads as noise, repeats empty
 * fields every step, and never marks progress; short numbered lines do better.
 */
function renderPlan(plan: Plan): string {
  const lines = [
    `Current plan (follow it; deviate only with good reason):${plan.reasoning ? ` ${plan.reasoning}` : ''}`,
  ];
  lines.push(...plan.steps.map((step, index) => `  ${index + 1}. ${step}`));
  if (plan.missingInfo.length > 0) {
    lines.push(`Missing info to resolve first: ${plan.missingInfo.join('; ')}`);
  }
  if (plan.deadline) lines.push(`Deadline: ${plan.deadline}`);
  return lines.join('\n');
}

function readLookupDirective(request: PersonalReadRequest): string {
  const terms =
    request.queryTerms.length > 0 ? ` Search terms: ${request.queryTerms.join(' ')}.` : '';
  return [
    '\nThis is a private calendar/email lookup. Do not ask which calendar, provider, inbox, or account to use.',
    request.kind === 'calendar'
      ? 'Read every calendar available to the assistant. Omit calendarIds so the tool searches all of them.'
      : request.kind === 'email'
        ? 'Search the assistant Gmail account (all mail unless the owner explicitly narrowed it).'
        : 'Search BOTH every calendar available to the assistant and the assistant Gmail account. Read a matching email thread before using details that are not in search metadata.',
    `Use only literal facts returned by successful reads in this task.${terms}`,
    'A zero-result search is a valid answer. A failed or partial source is a coverage gap; name it and do not fill it with memory, guesses, likely details, or events from earlier turns.',
  ].join('\n');
}

function readRoutingFailure(request: PersonalReadRequest, toolName: string): string {
  const source =
    request.kind === 'calendar'
      ? 'the calendar'
      : request.kind === 'email'
        ? 'Gmail'
        : 'the calendar and Gmail';
  return `I couldn't complete the required ${source} lookup because ${toolName} could not be run successfully. I’m not going to guess at the answer.`;
}

export async function runStepLoop(rc: RunContext, plan: Plan | null): Promise<ExecuteResult> {
  const { deps, db, router, dispatcher, task, agent, state, ctx, artifactIntent } = rc;
  const lease = task;
  // One clock for the whole run: the system prompt embeds it, and a per-step
  // timestamp would break the cacheable prompt prefix on every minute boundary.
  const runStartedAt = new Date();
  // Relative dates belong to the owner's request, not the worker attempt. A
  // crash/retry tomorrow must not silently move "Monday" to a different week.
  const readReferenceAt = task.createdAt;
  // Private calendar/mail forcing belongs only to direct owner requests. Never
  // let third-party text or an assistant-generated child task trigger a search
  // of the owner's accounts or override its explicit action plan.
  const readRequest =
    task.trust === 'owner'
      ? detectPersonalReadRequest(rc.window, {
          now: readReferenceAt,
          timeZone: agent.timezone,
        })
      : null;
  // Route action requests to the reasoning model (see roleForTask): a goal
  // session, a mission, an email to triage, or a chat/SMS turn the planner
  // routed to real work all drive tools on the strong model. The draft model
  // answers these with plausible prose and no tool calls — how a request can
  // look handled while nothing happened.
  const role = readRequest ? 'reason' : roleForTask(task, plan);
  // Forced artifact retries drop to the role's fallback because the DRAFT
  // primary (deepseek) intermittently times out when a tool is mandatory. The
  // reasoning primary (Claude) has no such issue, and its fallback is the
  // WEAKER draft model — so on a reason task, forcing the fallback is a pure
  // downgrade. Keep the fallback only for draft; a hard task on reason stays on
  // the strong model through its retries (the missing escalation path, E2).
  const useForcedToolFallback = role !== 'reason';
  const privilegedTask = task.trust === 'owner' || task.trust === 'assistant';
  const ownerCard =
    privilegedTask && !readRequest && !state.untrustedContext ? await getOwnerCard(db) : undefined;

  // Ambient "right now" context (Phase 25): the fused location + weather block
  // (falls back to location-only when the snapshot is stale). Owner-private and
  // transient, so it mirrors the owner-card gate.
  let ambientBlock: string | undefined;
  if (privilegedTask && !readRequest && !state.untrustedContext) {
    try {
      ambientBlock = await getAmbientBlock(db, agent.id);
    } catch (err) {
      console.error('ambient lookup failed — continuing without it', err);
    }
  }

  // Auto-recall. Chat, email, and SMS turns each get memory about the sender
  // and subject injected BEFORE the model runs, so an owner request is grounded
  // in prior discussion without the model having to call memory.recall (which
  // would taint the session). Email is the least-grounded actionable path, so
  // extending recall to it directly supports "consult past discussion, don't
  // guess". Owner-private + untainted only, mirroring the owner-card gate;
  // best-effort by design. A forwarded (tainted) email skips this — the model
  // can still use contacts.lookup / memory.recall there.
  let recallBlock: string | undefined;
  if (
    loadConfig().CHAT_RECALL_ENABLED &&
    !readRequest &&
    privilegedTask &&
    !state.untrustedContext &&
    (task.type === 'chat_turn' || task.type === 'email_triage' || task.type === 'sms_turn') &&
    task.conversationId
  ) {
    const conversationId = task.conversationId;
    const lastUser = [...rc.window].reverse().find((m) => m.role === 'user');
    const payload = (task.trigger as { payload?: Record<string, unknown> } | null)?.payload ?? {};
    const emailMeta =
      task.type === 'email_triage'
        ? [payload.subject, payload.from].filter((v) => typeof v === 'string').join(' ')
        : '';
    const baseText =
      (typeof lastUser?.content === 'string' && lastUser.content) ||
      (typeof payload.text === 'string' ? payload.text : '');
    const queryText = `${emailMeta} ${baseText}`.trim();
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
  // as ADVICE (never auto-run). Unlike the owner card / recall / ambient blocks,
  // skills are NOT gated on taint: they are the assistant's own procedural
  // advice ("how to handle an application confirmation"), not owner-private
  // facts, and email triage — the most-used actionable path — is set tainted
  // before step 0, so gating them there stripped learned competence from
  // exactly the path that needs it. The dispatcher's taint-approval gate still
  // holds every outward action, so surfacing a procedure changes how well the
  // task is done, not what it is allowed to do. Fetched once and reused across
  // loop iterations — the library is task-stable.
  let skillsBlock: string | undefined;
  if (privilegedTask && !readRequest) {
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
        const found = await recallSkills(db, router, agent.id, skillQuery, {
          taskId: task.id,
        });
        if (found.length > 0) {
          skillsBlock = renderSkillsBlock(found);
          state.usedSkillIds = found.map((skill) => skill.id);
          await bumpSkillUse(db, state.usedSkillIds);
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
  // One step beyond maxSteps is reserved for runtime-owned goal bookkeeping. A
  // session whose final work step spent the whole budget — or a retried task
  // already at the cap — must still be able to save its verified progress. The
  // bonus step cannot extend real work: it dispatches only
  // goals.update_progress with a conservative summary built from the durable
  // tool ledger. Measured from the entry step so a retry after a real database
  // failure gets exactly one fresh persistence attempt instead of none.
  const bookkeepingStepCap = Math.max(task.maxSteps, state.step) + 1;
  while (state.step < bookkeepingStepCap) {
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
    const readToolEvidence: ReadToolEvidence[] = readRequest
      ? await db
          .select({
            toolName: toolCalls.toolName,
            status: toolCalls.status,
            args: toolCalls.args,
            result: toolCalls.result,
            error: toolCalls.error,
          })
          .from(toolCalls)
          .where(eq(toolCalls.taskId, task.id))
      : [];
    const forcedReadTool =
      !mustRecordGoalProgress && readRequest
        ? nextRequiredReadTool(readRequest, readToolEvidence)
        : undefined;
    // Once every required read has either succeeded or exhausted its bounded
    // retries, answer straight from the ledger. No model gets a chance to add a
    // plausible event, reinterpret a date, ask which account to use, or perform
    // an unrequested follow-up action.
    if (readRequest && !mustRecordGoalProgress && !forcedReadTool) {
      const checked = enforcePersonalReadResponse(
        readRequest,
        readToolEvidence.map((row) => ({ ...row, result: row.result })),
      );
      rc.window.push({ role: 'assistant', content: checked.text } as ModelMessage);
      return stageFinalResponse(deps, lease, state, rc.window, {
        text: checked.text,
        progress: checked.text.slice(0, 200),
        terminalStatus: 'done',
        outcome: 'done',
        contractBlocked: checked.blocked,
        contractUnsupportedCount: checked.unsupported.length,
        contractNotice: checked.blocked || undefined,
      });
    }
    // Past the ordinary budget, only the owed bookkeeping turn may run.
    if (state.step >= task.maxSteps && !mustRecordGoalProgress) break;
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
        now: runStartedAt,
      }),
      channelContext(task),
      isUnattendedGoalSession(task)
        ? `\nThis automatic session is bound to Goal ID ${task.goalId}. Work only on this goal; the runtime owns progress persistence.`
        : '',
      plan ? `\n${renderPlan(plan)}` : '',
      readRequest ? readLookupDirective(readRequest) : '',
      plan?.action === 'schedule' ? SCHEDULE_DIRECTIVE : '',
    ]
      .filter(Boolean)
      .join('\n');
    // A mission work session carries the mission id in its trigger payload
    // (isMissionSessionTask). Keying off that — rather than "any adhoc child" —
    // stops unrelated adhoc children (e.g. the D9 known-sender-reply child) from
    // being offered mission.update, which they can only ever call in error.
    const availableToolDefs = dispatcher.toolDefs(task.trust as Trust, {
      isMissionSession: isMissionSessionTask(task),
    });
    // Automatic goal checkpoints are runtime capabilities, not model
    // capabilities. Hiding the tool prevents an eager model from persisting
    // unverified prose before the ledger-backed checkpoint runs.
    const toolDefs = isUnattendedGoalSession(task)
      ? availableToolDefs.filter((tool) => tool.name !== 'goals.update_progress')
      : availableToolDefs;
    const toolSet = Object.fromEntries(
      toolDefs.map((def) => [
        def.name,
        { description: def.description, inputSchema: def.inputSchema },
      ]),
    );
    const forcedArtifact = !mustRecordGoalProgress && state.step === 0 ? artifactIntent : undefined;
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
    if (forcedReadTool && !toolDefs.some((tool) => tool.name === forcedReadTool)) {
      const text = readRoutingFailure(readRequest as PersonalReadRequest, forcedReadTool);
      rc.window.push({ role: 'assistant', content: text } as ModelMessage);
      return stageFinalResponse(deps, lease, state, rc.window, {
        text,
        progress: text.slice(0, 200),
        terminalStatus: 'failed',
        outcome: 'failed',
      });
    }
    if (
      mustRecordGoalProgress &&
      !availableToolDefs.some((tool) => tool.name === 'goals.update_progress')
    ) {
      return stopForUnsavedGoalProgress(
        deps,
        lease,
        state,
        rc.window,
        'goals.update_progress is not available to this task',
      );
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
      !mustRecordGoalProgress &&
      state.step === 0 &&
      (isUnattendedGoalSession(task) || plan?.action === 'workflow');

    let stepResult: StepCallOutcome;
    if (mustRecordGoalProgress) {
      const checkpoint = buildGoalProgressCheckpoint(goalToolEvidence);
      if (!task.goalId || !checkpoint) {
        return stopForUnsavedGoalProgress(
          deps,
          lease,
          state,
          rc.window,
          'the verified tool ledger could not produce a goal checkpoint',
        );
      }
      stepResult = {
        ok: true,
        modelId: 'runtime/verified-tool-ledger',
        degraded: false,
        text: '',
        toolCalls: [
          {
            toolCallId: `runtime-goal-progress-${task.id}-${state.step + 1}`,
            toolName: 'goals.update_progress',
            input: { goalId: task.goalId, ...checkpoint },
          },
        ],
        finishReason: 'tool-calls',
      };
    } else if (forcedReadTool && readRequest) {
      const input = buildReadToolInput(readRequest, forcedReadTool, readToolEvidence);
      if (!input) {
        const text = readRoutingFailure(readRequest, forcedReadTool);
        rc.window.push({ role: 'assistant', content: text } as ModelMessage);
        return stageFinalResponse(deps, lease, state, rc.window, {
          text,
          progress: text.slice(0, 200),
          terminalStatus: 'failed',
          outcome: 'failed',
        });
      }
      stepResult = {
        ok: true,
        modelId: 'runtime/private-read-router',
        degraded: false,
        text: '',
        toolCalls: [
          {
            toolCallId: `runtime-private-read-${task.id}-${state.step + 1}`,
            toolName: forcedReadTool,
            input,
          },
        ],
        finishReason: 'tool-calls',
      };
    } else {
      stepResult = await router.step(role, {
        taskId: task.id,
        system,
        messages: rc.window,
        tools: toolSet as never,
        toolChoice: forcedArtifact
          ? { type: 'tool', toolName: forcedArtifact.toolName }
          : mustAct
            ? 'required'
            : undefined,
        // The primary chat model has intermittently timed out when a named
        // artifact tool is mandatory. Use the role's configured
        // tool-capable fallback where appropriate.
        forceFallback: useForcedToolFallback && Boolean(forcedArtifact),
        critical,
      });
      if (!(await renewTaskLease(db, lease))) return LOST_LEASE;
    }

    if (stepResult.ok && isUnattendedGoalSession(task) && !mustRecordGoalProgress) {
      stepResult = {
        ...stepResult,
        toolCalls: stepResult.toolCalls.filter(
          (toolCall) => toolCall.toolName !== 'goals.update_progress',
        ),
      };
    }

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

    // Approval cards and codes are runtime records, never prose generated by
    // the model. If it mimics an earlier approval notice without a tool call,
    // give it one constrained chance to emit the real gated action instead of
    // publishing a phantom code that cannot exist on the Approvals page.
    if (
      stepResult.ok &&
      stepResult.toolCalls.length === 0 &&
      isSimulatedApprovalNotice(stepResult.text)
    ) {
      console.warn('retrying simulated approval notice without a tool call', {
        taskId: task.id,
      });
      state.mustActRetries += 1;
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

    // A 'required' tool choice is advisory for some providers. If a step we forced
    // to act still returned no tool call, give it one constrained retry on the
    // tool-capable fallback before letting it fall through to prose — otherwise a
    // forwarded/planned action silently no-ops. (Forced artifacts have a
    // dedicated retry; private reads and goal progress bypass the model.)
    if (
      stepResult.ok &&
      mustAct &&
      !forcedReadTool &&
      !mustRecordGoalProgress &&
      stepResult.toolCalls.length === 0 &&
      !isSimulatedApprovalNotice(stepResult.text)
    ) {
      console.warn('retrying forced action step with no tool call', {
        taskId: task.id,
      });
      state.mustActRetries += 1;
      stepResult = await router.step(role, {
        taskId: task.id,
        system: `${system}\n\nThis request needs an action, not a summary. Emit the appropriate tool call now; do not answer in prose until you have.`,
        messages: rc.window,
        tools: toolSet as never,
        toolChoice: 'required',
        forceFallback: useForcedToolFallback,
        critical,
      });
      if (!(await renewTaskLease(db, lease))) return LOST_LEASE;
    }

    // The must-act retry above is another model boundary, so apply the same
    // runtime-only checkpoint rule to its output as well.
    if (stepResult.ok && isUnattendedGoalSession(task) && !mustRecordGoalProgress) {
      stepResult = {
        ...stepResult,
        toolCalls: stepResult.toolCalls.filter(
          (toolCall) => toolCall.toolName !== 'goals.update_progress',
        ),
      };
    }

    if (stepResult.ok && stepResult.degraded) {
      if (state.degradedSteps === 0) {
        console.warn('step served by the fallback model', {
          taskId: task.id,
          modelId: stepResult.modelId,
        });
      }
      state.degradedSteps += 1;
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
      await notifyAttention(deps, task, budgetRequest.text, [budgetRequest.part]);
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
      // A runtime progress step authorizes only the required bookkeeping write,
      // making the durable-success check below unambiguous.
      const requiredCall = stepResult.toolCalls.find(
        (toolCall) => toolCall.toolName === 'goals.update_progress',
      );
      if (requiredCall) stepResult = { ...stepResult, toolCalls: [requiredCall] };
    }
    if (forcedReadTool && readRequest) {
      // A forced read authorizes only that read, and runtime-owned bindings
      // remove model-invented calendar narrowing/query terms/thread ids.
      const requiredCall = stepResult.toolCalls.find(
        (toolCall) => toolCall.toolName === forcedReadTool,
      );
      if (requiredCall) {
        stepResult = {
          ...stepResult,
          toolCalls: [
            {
              ...requiredCall,
              input: groundReadToolInput(
                readRequest,
                forcedReadTool,
                requiredCall.input,
                readToolEvidence,
              ),
            },
          ],
        };
      }
    }
    if (task.goalId) {
      // Goal identity is runtime-owned. Automatic checkpoints are also built by
      // the runtime; explicit progress calls from owner chat are still rebound
      // here so no model has to copy an opaque UUID. The dispatcher's binding
      // check remains in place as defense in depth for every other caller.
      stepResult = {
        ...stepResult,
        toolCalls: stepResult.toolCalls.map((toolCall) =>
          toolCall.toolName === 'goals.update_progress'
            ? { ...toolCall, input: { ...toolCall.input, goalId: task.goalId } }
            : toolCall,
        ),
      };
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
            rc.window.push(
              toolResultMessage(tc.toolCallId, tc.toolName, outcome.result, {
                dbToolCallId: outcome.toolCallId,
              }),
            );
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
          rc.window.push(
            toolResultMessage(tc.toolCallId, tc.toolName, {
              error: outcome.reason,
            }),
          );
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
        // The conversation must not go silent while parked — tell the owner
        // exactly what is waiting and where to approve it.
        //
        // This lands BEFORE the owner ping on purpose. parkForApproval above
        // already publishes waiting_approval, and notifyApproval is a
        // sequential run of outbound SMS calls (one per approval). Pinging
        // first left the chat poller able to observe "waiting for approval"
        // for seconds while the card naming what was waiting did not exist
        // yet — it stopped polling and the card only appeared on a reload.
        const conversationNotified = await postConversationNotice(
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
        await markApprovalsNotified(
          db,
          approvalNotices.map((notice) => notice.approvalId),
          deliveredChannels({ ownerNotified, conversationNotified }),
        );
        return {
          outcome: 'parked',
          detail: `${pendingApprovals.length} approval(s) pending`,
        };
      }

      if (state.pendingJob) {
        const slept = await sleepTask(db, lease, state, new Date(state.pendingJob.timeoutAt));
        if (!slept) return LOST_LEASE;
        return { outcome: 'sleeping', detail: 'browser job running' };
      }

      if (!(await checkpointTask(db, lease, state))) return LOST_LEASE;
      continue;
    }

    // A forced-action step (mustAct) that produced only prose — even after its
    // one constrained retry above — did NOT do the work it was planned to do.
    // On an unattended path, staging that prose as `done` is the "zero tool
    // calls, looks handled, wasn't" bug (A2): the forwarded/planned action
    // silently no-ops. Park needs_attention with an honest message the owner can
    // retry instead. chat_turn/sms_turn deliberately keep prose-as-done — the
    // owner is watching live and the honest message IS the reply. Unattended
    // goal sessions are handled just below by stageModelFinalResponse, which
    // already converts a no-verified-evidence final to needs_attention.
    if (
      mustAct &&
      !isUnattendedGoalSession(task) &&
      task.type !== 'chat_turn' &&
      task.type !== 'sms_turn'
    ) {
      const honest =
        "I planned to act on this but couldn't produce a concrete action, so I've stopped rather than pretend it's done. Retry it from Activity, or tell me exactly what to do.";
      rc.window.push({ role: 'assistant', content: honest } as ModelMessage);
      // stageFinalResponse delivers the honest text through the task's channel
      // (email reply / Notifications) and, being a needs_attention final, stamps
      // it notified via the Phase-1/2 path — so no separate notify is needed.
      return stageFinalResponse(deps, lease, state, rc.window, {
        text: honest,
        progress: 'forced action produced no tool call',
        terminalStatus: 'needs_attention',
        outcome: 'needs_attention',
      });
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

  // A small task budget can end a private lookup before every source/thread is
  // read. Return the ledger-backed partial answer and explicit coverage gaps;
  // never replace it with generic progress prose or ask the owner to choose a
  // provider. Goal sessions retain their stricter progress-persistence path.
  if (readRequest && !isUnattendedGoalSession(task)) {
    const readToolEvidence = await db
      .select({
        toolName: toolCalls.toolName,
        status: toolCalls.status,
        args: toolCalls.args,
        result: toolCalls.result,
        error: toolCalls.error,
      })
      .from(toolCalls)
      .where(eq(toolCalls.taskId, task.id));
    const checked = enforcePersonalReadResponse(
      readRequest,
      readToolEvidence.map((row) => ({ ...row, result: row.result })),
    );
    rc.window.push({ role: 'assistant', content: checked.text } as ModelMessage);
    return stageFinalResponse(deps, lease, state, rc.window, {
      text: checked.text,
      progress: checked.text.slice(0, 200),
      terminalStatus: 'done',
      outcome: 'done',
      contractBlocked: checked.blocked,
      contractUnsupportedCount: checked.unsupported.length,
      contractNotice: checked.blocked || undefined,
    });
  }

  // max steps exhausted
  const stuck = `stopped after ${task.maxSteps} steps without finishing`;
  // The scratchpad is only written by mission.update, so for every other task
  // type the best available summary is the model's own last words. "See task
  // log" is the worst possible message at the moment the owner most needs one.
  const lastAssistantText = [...rc.window]
    .reverse()
    .find((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim());
  const lastProgress =
    state.scratchpad ||
    (typeof lastAssistantText?.content === 'string'
      ? lastAssistantText.content.slice(0, 400)
      : 'no summary was recorded — the step-by-step record is on the task page.');
  const stuckMessage = `I ${stuck}. Here's where I got: ${lastProgress}`;
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
      rc.window.push({
        role: 'assistant',
        content: stuckMessage,
      } as ModelMessage);
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
