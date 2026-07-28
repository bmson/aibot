import { type Db, skills, type TaskRow, tasks, toolCalls } from '@assistant/db';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { BudgetReservationError, nextDailyReset, nextMonthlyReset } from '../cost.js';
import { isUnparseableObjectError, type ModelRouter } from '../model-router/router.js';
import { withSpan } from '../otel.js';
import { saveSkill } from './skills.js';

/**
 * Skill reflection (Phase 26): nightly, review recently completed tasks that did
 * real, multi-step tool work and decide whether any solved something non-obvious
 * worth distilling into a reusable procedure. A tainted task can NEVER produce a
 * skill — checked against both the trigger's provenance AND the persisted
 * `state.untrustedContext` (taint can be acquired mid-run).
 */

/**
 * A compact, redacted rendering of a tool call's arguments for the reflection
 * prompt. Keys always; values only when short and not secret-shaped. This is
 * what turns "gmail.search → succeeded" into something a procedure can be
 * learned from without copying message bodies into a skill.
 */
function sketchArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const SECRET_KEY = /token|secret|password|key|auth/i;
  return Object.entries(args as Record<string, unknown>)
    .slice(0, 6)
    .map(([key, value]) => {
      if (SECRET_KEY.test(key)) return `${key}: …`;
      if (typeof value === 'string' && value.length <= 60)
        return `${key}: ${JSON.stringify(value)}`;
      if (typeof value === 'number' || typeof value === 'boolean') return `${key}: ${value}`;
      return `${key}: …`;
    })
    .join(', ');
}

const WINDOW_HOURS = 26;
const MAX_TASKS = 8;
const MIN_SUCCEEDED_CALLS = 2;

const SkillDraftSchema = z.object({
  worthSkill: z
    .boolean()
    .describe('true ONLY if this task solved something non-obvious worth reusing as a procedure'),
  name: z.string().max(200).default(''),
  preconditions: z.string().max(500).default(''),
  steps: z.string().max(2000).default(''),
  gotchas: z.string().max(1000).default(''),
});

const REFLECT_SYSTEM = [
  'You review one task the assistant already completed and decide whether it taught a reusable PROCEDURE worth remembering (a Voyager-style skill).',
  'Say worthSkill=true ONLY when the successful path was non-obvious — a workaround, a specific sequence of tools, a constraint discovered, a gotcha avoided. Routine one-step tasks and ordinary replies are NOT skills.',
  'When worthSkill=true, draft: a short imperative name (e.g. "Booking flights"), when it applies (preconditions), the steps as plain-language ADVICE (not code), and any gotchas. Otherwise worthSkill=false and leave the fields empty.',
].join('\n');

/** Taint check inlined to avoid importing the executor (would cycle via jobs.ts). */
function taskIsTainted(task: Pick<TaskRow, 'trust' | 'trigger' | 'state'>): boolean {
  const state = (task.state ?? {}) as { untrustedContext?: unknown };
  if (state.untrustedContext === true) return true;
  if (task.trust === 'known' || task.trust === 'unknown') return true;
  const trigger = task.trigger as {
    source?: unknown;
    payload?: { quotesExternalContent?: unknown; taintedOrigin?: unknown };
  } | null;
  if (trigger?.payload?.taintedOrigin === true) return true;
  if (trigger?.source !== 'email') return false;
  return !(task.trust === 'owner' && trigger.payload?.quotesExternalContent === false);
}

function taskGoal(task: TaskRow): string {
  const payload = (task.trigger as { payload?: Record<string, unknown> } | null)?.payload ?? {};
  const instruction =
    (typeof payload.instruction === 'string' && payload.instruction) ||
    (typeof payload.text === 'string' && payload.text) ||
    '';
  const planReasoning = (task.plan as { reasoning?: unknown } | null)?.reasoning;
  return (
    instruction ||
    (typeof planReasoning === 'string' ? planReasoning : '') ||
    '(no explicit goal)'
  ).slice(0, 1000);
}

export interface SkillReflectionResult {
  tasksReviewed: number;
  skillsDrafted: number;
}

export async function runSkillReflection(
  deps: { db: Db; router: ModelRouter; heartbeat?: () => Promise<void> },
  opts: { taskId?: string; since?: Date } = {},
): Promise<SkillReflectionResult> {
  const { db, router } = deps;
  const since = opts.since ?? new Date(Date.now() - WINDOW_HOURS * 3600 * 1000);

  return withSpan('skill.reflect', {}, async () => {
    const result: SkillReflectionResult = { tasksReviewed: 0, skillsDrafted: 0 };
    await deps.heartbeat?.();

    const candidates = await db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.status, 'done'),
          inArray(tasks.trust, ['owner', 'assistant']),
          gte(tasks.createdAt, since),
        ),
      )
      .orderBy(desc(tasks.createdAt))
      .limit(40);
    if (candidates.length === 0) return result;

    // Skip tasks that already taught a skill (idempotent across nightly runs).
    const alreadySourced = new Set(
      (
        await db
          .select({ sourceTaskId: skills.sourceTaskId })
          .from(skills)
          .where(
            inArray(
              skills.sourceTaskId,
              candidates.map((t) => t.id),
            ),
          )
      )
        .map((r) => r.sourceTaskId)
        .filter((id): id is string => Boolean(id)),
    );

    const eligible = candidates.filter((t) => !taskIsTainted(t) && !alreadySourced.has(t.id));

    for (const task of eligible) {
      if (result.tasksReviewed >= MAX_TASKS) break;
      await deps.heartbeat?.();

      const calls = await db
        .select({
          toolName: toolCalls.toolName,
          status: toolCalls.status,
          error: toolCalls.error,
          args: toolCalls.args,
        })
        .from(toolCalls)
        .where(eq(toolCalls.taskId, task.id))
        .orderBy(toolCalls.step);
      const succeeded = calls.filter((c) => c.status === 'succeeded');
      if (succeeded.length < MIN_SUCCEEDED_CALLS) continue;
      result.tasksReviewed += 1;

      // A name-and-status list ("gmail.search → succeeded") gives the model
      // nothing to distill a procedure from. Include a redacted sketch of the
      // arguments (keys, and short values that are not obviously sensitive)
      // and the task's recorded outcome, which is what carries the "how".
      const transcript = [
        `Goal: ${taskGoal(task)}`,
        'Actions taken (in order):',
        ...calls.map(
          (c) =>
            `- ${c.toolName}(${sketchArgs(c.args)}) → ${c.status}${c.error ? ` (error: ${c.error.slice(0, 120)})` : ''}`,
        ),
        ...(task.progress ? ['', `Recorded outcome: ${task.progress.slice(0, 400)}`] : []),
      ].join('\n');

      const outcome = await router
        .object<z.infer<typeof SkillDraftSchema>>('batch', {
          taskId: opts.taskId,
          schema: SkillDraftSchema,
          system: REFLECT_SYSTEM,
          prompt: transcript,
        })
        .catch((err) => {
          if (!isUnparseableObjectError(err)) throw err;
          console.error(`skill reflection: skipping unstructurable task ${task.id}`, err);
          return null;
        });
      await deps.heartbeat?.();
      if (outcome === null) continue;
      if (!outcome.ok) {
        throw new BudgetReservationError(
          outcome.decision.reason,
          outcome.decision.reason.includes('monthly') ? nextMonthlyReset() : nextDailyReset(),
        );
      }

      const draft = outcome.object;
      if (!draft.worthSkill || !draft.name.trim() || !draft.steps.trim()) continue;
      const saved = await saveSkill(db, router, {
        agentId: task.agentId,
        name: draft.name,
        preconditions: draft.preconditions,
        steps: draft.steps,
        gotchas: draft.gotchas,
        sourceTaskId: task.id,
        // The task is owner/assistant-trust and passed the taint gate above.
        originTrust: task.trust === 'owner' ? 'owner' : 'assistant',
      });
      if (saved.saved) result.skillsDrafted += 1;
    }

    return result;
  });
}
