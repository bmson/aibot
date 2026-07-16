import type { Db, TaskRow } from '@assistant/db';
import { approvals, tasks, toolCalls } from '@assistant/db';
import type { ModelMessage } from 'ai';
import { eq, inArray } from 'drizzle-orm';
import type { ZodType } from 'zod';
import { isBrowserJobPending } from '../browse.js';
import {
  buildSystemPrompt,
  getAgent,
  listMessages,
  PROMPT_VERSION,
  persistMessage,
} from '../chat.js';
import { PlanSchema, type TaskState, type Trust } from '../events.js';
import type { ModelRole, ModelRouter } from '../model-router/router.js';
import { withSpan } from '../otel.js';
import {
  checkpointTask,
  claimTask,
  completeTask,
  parkForApproval,
  recordFailedAttempt,
  sleepTask,
  taskState,
} from './machine.js';
import { startMission, wakeMission } from './missions.js';
import { PLANNER_VERSION, planTask } from './planner.js';

/** Structural port implemented by @assistant/tools' ToolDispatcher — keeps core free of a package cycle. */
export interface DispatcherPort {
  toolDefs(trust: Trust): Array<{ name: string; description: string; inputSchema: ZodType }>;
  dispatch(input: {
    task: TaskRow;
    step: number;
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
  >;
  executeApproved(
    toolCallId: string,
    ctx: ToolContextLike,
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: string }>;
}

export interface ToolContextLike {
  taskId: string;
  agentId: string;
  conversationId?: string;
  trust: Trust;
  db: Db;
  now: () => Date;
  signal: AbortSignal;
  log: (type: string, payload: unknown) => Promise<void>;
}

export interface ExecutorDeps {
  db: Db;
  router: ModelRouter;
  dispatcher: DispatcherPort;
  /** Channel delivery for a task's final text (e.g. SMS reply). Failures log, never crash the task. */
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

function truncateResult(result: unknown): unknown {
  const json = JSON.stringify(result ?? null);
  if (json.length <= RESULT_CHAR_LIMIT) return result ?? null;
  return {
    truncated: true,
    note: `result truncated from ${json.length} chars; full result stored in tool_calls`,
    preview: json.slice(0, RESULT_CHAR_LIMIT),
  };
}

function toolResultMessage(toolCallId: string, toolName: string, value: unknown): ModelMessage {
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

async function seedContext(db: Db, task: TaskRow): Promise<ModelMessage[]> {
  if (task.conversationId) {
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
      const disposition = await recordFailedAttempt(db, task, String(err));
      return {
        outcome: disposition === 'dead_letter' ? 'dead_letter' : 'failed',
        detail: String(err).slice(0, 500),
      };
    }
  });
}

async function runSteps(deps: ExecutorDeps, task: TaskRow): Promise<ExecuteResult> {
  const { db, router, dispatcher } = deps;
  const agent = await getAgent(db);
  const state = taskState(task);
  const abort = new AbortController();

  // Missions never run the step loop themselves: each wake is a deadline
  // check, a reflection, or a fresh bounded session child.
  if (task.type === 'mission') {
    const wake = await wakeMission({ db, router }, task, agent);
    return {
      outcome: wake.action === 'deadline_reached' ? 'done' : 'sleeping',
      detail: wake.action,
    };
  }

  const ctx: ToolContextLike = {
    taskId: task.id,
    agentId: task.agentId,
    conversationId: task.conversationId ?? undefined,
    trust: task.trust as Trust,
    db,
    now: () => new Date(),
    signal: abort.signal,
    log: async () => {},
  };

  let window = state.contextWindow as unknown as ModelMessage[];
  if (window.length === 0) {
    window = await seedContext(db, task);
  }

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
      state.completedToolCallIds.push(pending.dbToolCallId);
      state.pendingJob = null;
    } else if (timedOut || !row) {
      const settled = {
        ok: false,
        error: 'the browser job never reported back (timed out) — treat this attempt as failed',
      };
      if (row) {
        await db.update(toolCalls).set({ result: settled }).where(eq(toolCalls.id, row.id));
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

    for (const pending of state.pendingApprovals) {
      const approval = byId.get(pending.approvalId);
      if (!approval || approval.status === 'pending') {
        stillPending.push(pending);
        continue;
      }
      if (approval.status === 'approved') {
        const outcome = await dispatcher.executeApproved(pending.dbToolCallId, ctx);
        if (outcome.ok && isBrowserJobPending(outcome.result)) {
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
              outcome.ok ? outcome.result : { error: outcome.error },
            ),
          );
          state.completedToolCallIds.push(pending.dbToolCallId);
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
      await parkForApproval(db, task.id, state, stillPending);
      return { outcome: 'parked', detail: 'still waiting on approvals' };
    }
    state.pendingApprovals = [];
  }

  // A browser job is (still) in flight — sleep until its callback or timeout.
  if (state.pendingJob) {
    state.contextWindow = compact(window) as unknown as TaskState['contextWindow'];
    await sleepTask(db, task.id, state, new Date(state.pendingJob.timeoutAt));
    return { outcome: 'sleeping', detail: 'browser job running' };
  }

  // ── Plan (decide, don't execute) ──────────────────────────────────────────
  let plan = task.plan ? PlanSchema.parse(task.plan) : null;
  if (!plan) {
    plan = await planTask({ db, router }, task, agent, window);
    if (plan?.action === 'mission') {
      const statement = plan.steps.length
        ? `${plan.reasoning || 'Long-horizon work'} — steps: ${plan.steps.join('; ')}`
        : plan.reasoning || 'Long-horizon work from owner request';
      const mission = await startMission(db, task, plan, statement);
      const confirmation = `Started a mission for this (id ${mission.id.slice(0, 8)}). I'll work on it in daily sessions, reflect weekly on whether it's still worth pursuing, and report as things happen. It's visible under Monitoring on the dashboard.`;
      if (task.conversationId) {
        await persistMessage(db, {
          conversationId: task.conversationId,
          taskId: task.id,
          role: 'assistant',
          origin: 'assistant',
          parts: [{ type: 'text', text: confirmation }],
          text: confirmation,
        });
      }
      if (deps.deliverFinal) {
        await deps.deliverFinal(task, confirmation).catch(() => {});
      }
      await completeTask(db, task.id, { status: 'done', progress: 'spawned mission' });
      return { outcome: 'done', detail: `mission ${mission.id}` };
    }
    if (plan?.action === 'clarify' && task.conversationId) {
      const question =
        plan.missingInfo.length > 0
          ? `Before I proceed, I need to know: ${plan.missingInfo.join('; ')}`
          : 'I need more detail before I can act on this — what exactly would you like me to do?';
      await persistMessage(db, {
        conversationId: task.conversationId,
        taskId: task.id,
        role: 'assistant',
        origin: 'assistant',
        parts: [{ type: 'text', text: question }],
        text: question,
      });
      await completeTask(db, task.id, { status: 'done', progress: 'asked for clarification' });
      return { outcome: 'clarify' };
    }
  }

  const role = ROLE_FOR_TYPE[task.type] ?? 'draft';
  const system = [
    buildSystemPrompt(agent),
    plan
      ? `\nCurrent plan (follow it; deviate only with good reason):\n${JSON.stringify(plan)}`
      : '',
  ].join('\n');

  const toolDefs = dispatcher.toolDefs(task.trust as Trust);
  const toolSet = Object.fromEntries(
    toolDefs.map((def) => [
      def.name,
      { description: def.description, inputSchema: def.inputSchema },
    ]),
  );

  // ── Step loop ─────────────────────────────────────────────────────────────
  while (state.step < task.maxSteps) {
    const stepResult = await router.step(role, {
      taskId: task.id,
      system,
      messages: window,
      tools: toolSet as never,
    });

    if (!stepResult.ok) {
      if (stepResult.decision.mode === 'block') {
        // daily/monthly exhausted — sleep to the next day, don't kill the task
        const tomorrow = new Date();
        tomorrow.setHours(24, 5, 0, 0);
        state.contextWindow = compact(window) as unknown as TaskState['contextWindow'];
        await sleepTask(db, task.id, state, tomorrow);
        return { outcome: 'sleeping', detail: stepResult.decision.reason };
      }
      // task budget exhausted — surface to the owner on the dashboard
      await db
        .update(tasks)
        .set({ status: 'needs_attention', progress: `budget: ${stepResult.decision.reason}` })
        .where(eq(tasks.id, task.id));
      return { outcome: 'needs_attention', detail: stepResult.decision.reason };
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
      for (const tc of stepResult.toolCalls) {
        const outcome = await dispatcher.dispatch({
          task,
          step: state.step,
          toolName: tc.toolName,
          args: tc.input,
          ctx,
          provenance: {
            plannerVersion: PLANNER_VERSION,
            promptVersion: PROMPT_VERSION,
            model: stepResult.modelId,
          },
        });

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
          }
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
        await parkForApproval(db, task.id, state, pendingApprovals);
        if (deps.notifyApproval && approvalNotices.length > 0) {
          await deps
            .notifyApproval(approvalNotices)
            .catch((err) => console.error('approval notification failed', err));
        }
        return { outcome: 'parked', detail: `${pendingApprovals.length} approval(s) pending` };
      }

      if (state.pendingJob) {
        await sleepTask(db, task.id, state, new Date(state.pendingJob.timeoutAt));
        return { outcome: 'sleeping', detail: 'browser job running' };
      }

      await checkpointTask(db, task.id, state);
      continue;
    }

    // no tool calls → final answer
    const text = stepResult.text.trim() || '(no response)';
    if (task.conversationId) {
      await persistMessage(db, {
        conversationId: task.conversationId,
        taskId: task.id,
        role: 'assistant',
        origin: 'assistant',
        parts: [{ type: 'text', text }],
        text,
      });
    }
    if (deps.deliverFinal) {
      await deps
        .deliverFinal(task, text)
        .catch((err) => console.error('final delivery failed', err));
    }
    state.contextWindow = compact(window) as unknown as TaskState['contextWindow'];
    await checkpointTask(db, task.id, state);
    await completeTask(db, task.id, { status: 'done', progress: text.slice(0, 200) });
    return { outcome: 'done', detail: text.slice(0, 200) };
  }

  // max steps exhausted
  const stuck = `stopped after ${task.maxSteps} steps without finishing`;
  if (task.conversationId) {
    await persistMessage(db, {
      conversationId: task.conversationId,
      taskId: task.id,
      role: 'assistant',
      origin: 'assistant',
      parts: [
        {
          type: 'text',
          text: `I ${stuck}. Here's where I got: ${state.scratchpad || 'see task log.'}`,
        },
      ],
      text: stuck,
    });
  }
  await completeTask(db, task.id, { status: 'failed', progress: stuck });
  return { outcome: 'failed', detail: stuck };
}
