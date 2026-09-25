import type { GoalToolRepository, MissionProgressRepository } from '@assistant/persistence';
import { z } from 'zod';
import { register } from '../register.js';
import type { ToolRegistry } from '../registry.js';

/**
 * Install mission.update, goals.list, and goals.create on persistence ports.
 * The definitions match the PostgreSQL built-ins; see those for the reasoning
 * behind each trust setting.
 */
export function registerPortableGoalTools(
  registry: ToolRegistry,
  deps: { goals: GoalToolRepository; missions: MissionProgressRepository },
): ToolRegistry {
  register(registry, {
    name: 'mission.update',
    description:
      'Update your parent mission after a work session: progress summary, next action, optional percent, and notes for the next session. Call this before finishing a mission session.',
    inputSchema: z.object({
      progress: z.string().min(3).max(1000),
      nextAction: z.string().max(500).default(''),
      progressPercent: z.number().int().min(0).max(100).nullish(),
      notes: z.string().max(2000).default(''),
    }),
    risk: 'autonomous',
    // A mission session reads untrusted content before it can summarise
    // progress. This writes bounded model-authored text to the assistant's own
    // mission, and the dispatcher's parent-mission gate limits it to sessions.
    acceptsUntrustedInput: true,
    execute: async (args, ctx) =>
      deps.missions.recordSessionProgress({
        agentId: ctx.agentId,
        sessionTaskId: ctx.taskId,
        progress: args.progress,
        nextAction: args.nextAction,
        progressPercent: args.progressPercent,
        notes: args.notes,
      }),
  });

  register(
    registry,
    {
      name: 'goals.list',
      description: "List the owner's long-term goals (active first).",
      inputSchema: z.object({}),
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      // Owner- or assistant-authored reference data, as in the PostgreSQL tool.
      execute: async (_args, ctx) => ({
        goals: (await deps.goals.listStanding(ctx.agentId)).map((goal) => ({
          id: goal.id,
          title: goal.title,
          status: goal.status,
          priority: goal.priority,
          progress: goal.progress,
          nextAction: goal.nextAction,
          targetDate: goal.targetDate?.toISOString() ?? null,
        })),
      }),
    },
    { confidentialRead: true },
  );

  register(
    registry,
    {
      name: 'goals.create',
      description:
        'Create a new long-term goal for the owner. Requires owner approval — goals shape long-running behavior.',
      inputSchema: z.object({
        title: z.string().min(3).max(200),
        description: z.string().max(2000).default(''),
        priority: z.number().int().min(1).max(5).default(3),
        targetDate: z.string().datetime({ offset: true }).optional(),
      }),
      risk: 'approval',
      acceptsUntrustedInput: false,
      // The description becomes the automation's standing instruction, so the
      // owner must see it on the approval card.
      approvalSummary: (args) => {
        const a = args as { title: string; description?: string };
        const desc = a.description?.trim();
        return `Create goal "${a.title}"${desc ? ` — ${desc.slice(0, 300)}` : ''}`;
      },
      execute: async (args, ctx) => {
        const { goalId } = await deps.goals.create({
          agentId: ctx.agentId,
          title: args.title,
          description: args.description,
          priority: args.priority,
          targetDate: args.targetDate ? new Date(args.targetDate) : null,
          taintedOrigin: ctx.tainted,
        });
        return { goalId, title: args.title };
      },
    },
    // Durable, behavior-shaping owner state: taint-gated and never one-tap
    // SMS-approvable, like a memory write.
    { outwardFacing: false, writesMemory: true },
  );
  return registry;
}
