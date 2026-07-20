import type { AgentRow, Db, TaskRow } from '@assistant/db';
import { tasks } from '@assistant/db';
import type { ModelMessage } from 'ai';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { type Plan, PlanSchema } from '../events.js';
import type { ModelRouter } from '../model-router/router.js';

/** Bump whenever planner prompting changes behavior — recorded in tool_calls.decision. */
export const PLANNER_VERSION = 2;

const PLANNER_CONTEXT_LIMIT = 6000;

/**
 * The assistant's own prose is the least informative part of planner context
 * and by far the longest. A few repeated "before I proceed, I need to know…"
 * turns fill the whole budget and push the owner's actual answers out of it,
 * so the planner re-derives 'clarify' from its own questions and the goal
 * spins. Owner messages survive whole; the assistant's keep only their head.
 */
const PLANNER_ASSISTANT_CHAR_LIMIT = 400;

export function plannerContext(window: ModelMessage[]): string {
  return window
    .map((message) => {
      const content =
        typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
      const body =
        message.role === 'assistant' && content.length > PLANNER_ASSISTANT_CHAR_LIMIT
          ? `${content.slice(0, PLANNER_ASSISTANT_CHAR_LIMIT)}…`
          : content;
      return `${message.role}: ${body}`;
    })
    .join('\n')
    .slice(-PLANNER_CONTEXT_LIMIT);
}

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
    'Never ask for something the owner already answered earlier in the context, and never re-ask a question you already asked. Re-read the conversation for the answer before choosing clarify.',
    'Prefer acting on a reasonable default over asking. Choose clarify only when a wrong guess would be costly or irreversible.',
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
  const contextText = plannerContext(window);

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
