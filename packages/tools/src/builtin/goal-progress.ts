import type { GoalProgressRepository } from '@assistant/persistence';
import { z } from 'zod';
import { register } from '../register.js';
import type { ToolRegistry } from '../registry.js';

/** Install the goal progress capability without registering SQL-only goal tools. */
export function registerPortableGoalProgressTool(
  registry: ToolRegistry,
  repository: GoalProgressRepository,
): ToolRegistry {
  register(registry, {
    name: 'goals.update_progress',
    description: 'Update the progress note and next action on an existing goal.',
    inputSchema: z.object({
      goalId: z.string().uuid(),
      progress: z.string().min(1).max(1000),
      nextAction: z.string().max(500).default(''),
    }),
    risk: 'autonomous',
    // The dispatcher binds this write to the task's goal and requires prior
    // verified work evidence for unattended tasks. Research may taint a goal
    // session before it can report progress.
    acceptsUntrustedInput: true,
    execute: async (args, ctx) => {
      if (ctx.trust !== 'owner' && ctx.trust !== 'assistant')
        throw new Error('goals.update_progress is available only to owner/assistant tasks');
      return repository.updateProgress({
        agentId: ctx.agentId,
        goalId: args.goalId,
        progress: args.progress,
        nextAction: args.nextAction,
      });
    },
  });
  return registry;
}
