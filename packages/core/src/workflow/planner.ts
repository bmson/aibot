import type { AgentRow, Db, TaskRow } from '@assistant/db';
import { tasks } from '@assistant/db';
import type { ModelMessage } from 'ai';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { type Plan, PlanSchema } from '../events.js';
import type { ModelRouter } from '../model-router/router.js';

/** Bump whenever planner prompting changes behavior — recorded in tool_calls.decision. */
export const PLANNER_VERSION = 1;

const TrivialSchema = z.object({
  trivial: z
    .boolean()
    .describe('true if this is small talk or a simple question needing no tools or planning'),
});

function plannerSystem(agent: AgentRow): string {
  return [
    `You are the planning layer of ${agent.name}, a personal assistant. You DECIDE, you never execute.`,
    'Given the conversation/trigger, decide what should happen:',
    "- 'reply': a direct answer suffices (no tools, no multi-step work)",
    "- 'workflow': multi-step work executable now with the available tools",
    "- 'mission': long-horizon work spanning days/weeks (watching, waiting, recurring checks)",
    "- 'schedule': a one-off or recurring future action",
    "- 'clarify': you cannot act without more information from the owner — list missingInfo",
    'Keep steps short and concrete. Note what information is missing. Do not invent goals.',
  ].join('\n');
}

/**
 * The planner step. Trivial owner chat short-circuits via the cheap classify
 * role (a planner call on every "thanks!" would double cost and latency).
 * Returns null when planning is unnecessary or the budget guard blocked it —
 * the executor then proceeds plan-less (plain step loop).
 */
export async function planTask(
  deps: { db: Db; router: ModelRouter },
  task: TaskRow,
  agent: AgentRow,
  window: ModelMessage[],
): Promise<Plan | null> {
  const contextText = window
    .map(
      (m) => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`,
    )
    .join('\n')
    .slice(-6000);

  if (task.type === 'chat_turn' || task.type === 'sms_turn') {
    const triage = await deps.router.object<z.infer<typeof TrivialSchema>>('classify', {
      taskId: task.id,
      schema: TrivialSchema,
      system: 'Classify whether the latest owner message needs planning/tools or is trivial chat.',
      prompt: contextText,
    });
    if (!triage.ok || triage.object.trivial) return null;
  }

  const planned = await deps.router.object<Plan>('plan', {
    taskId: task.id,
    schema: PlanSchema,
    system: plannerSystem(agent),
    prompt: contextText,
  });
  if (!planned.ok) return null;

  const plan = PlanSchema.parse(planned.object);
  await deps.db.update(tasks).set({ plan }).where(eq(tasks.id, task.id));
  return plan;
}
