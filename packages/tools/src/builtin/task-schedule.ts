import type { TaskRepository } from '@assistant/persistence';
import { z } from 'zod';
import { register } from '../register.js';
import type { ToolRegistry } from '../registry.js';

/** Register future-self scheduling using only the portable task repository. */
export function registerPortableTaskTools(
  registry: ToolRegistry,
  deps: { tasks?: TaskRepository },
): ToolRegistry {
  register(registry, {
    name: 'task.schedule',
    description:
      'Defer work: schedule a future task for YOURSELF to run later (e.g. "check back on this thread tomorrow"). NOT for calendar events — calendar entries are created with calendar.create_event immediately, even when the event is in the future. when is an ISO 8601 timestamp.',
    inputSchema: z.object({
      when: z.string().datetime({ offset: true }),
      instruction: z.string().min(3).max(2000),
    }),
    risk: 'autonomous',
    acceptsUntrustedInput: false,
    approvalSummary: (args) => {
      const when = new Date(args.when);
      const at = Number.isNaN(when.getTime()) ? args.when : when.toISOString();
      return `Schedule a future task for ${at}: “${args.instruction.slice(0, 200)}”`;
    },
    execute: async (args, ctx) => {
      const runAfter = new Date(args.when);
      if (Number.isNaN(runAfter.getTime())) throw new Error('invalid timestamp');
      if (runAfter.getTime() <= ctx.now().getTime()) throw new Error('when must be in the future');
      if (!deps.tasks) throw new Error('task lifecycle repository unavailable');
      const result = await deps.tasks.createScheduledFollowUp({
        parentTaskId: ctx.taskId,
        agentId: ctx.agentId,
        conversationId: ctx.conversationId,
        instruction: args.instruction,
        runAfter,
        trust: ctx.trust === 'owner' ? 'owner' : 'assistant',
        tainted: ctx.tainted,
      });
      return { scheduled: result.created, taskId: result.task.id, runAfter: args.when };
    },
  });
  return registry;
}
