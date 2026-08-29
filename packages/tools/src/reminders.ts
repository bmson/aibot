import { randomUUID } from 'node:crypto';
import { getAgent, nextRun, upsertSchedule } from '@assistant/core';
import { schedules } from '@assistant/db';
import { and, desc, eq, like, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ToolRegistry } from './registry.js';
import type { AssistantTool, ToolFlags } from './types.js';

const REMINDER_PREFIX = 'reminder:';

function register<S extends z.ZodType, Out>(
  registry: ToolRegistry,
  tool: AssistantTool<S, Out>,
  flags: ToolFlags = {},
) {
  registry.register(tool as unknown as AssistantTool, flags);
}

/** Build a 5-field cron from a HH:MM time and optional weekday list (0=Sun). */
function cronFromTime(time: string, weekdays?: number[]): string {
  const [hour, minute] = time.split(':').map((n) => Number.parseInt(n, 10));
  const dow = weekdays && weekdays.length > 0 ? [...new Set(weekdays)].sort().join(',') : '*';
  return `${minute} ${hour} * * ${dow}`;
}

/**
 * Recurring reminders. Distinct from goals (open-ended work) and watches
 * (sender-triggered): a reminder is a cron that fires a tiny scheduled task
 * which just calls owner.notify with the reminder text. When created from a
 * chat, it fires back into that conversation; otherwise into the Notifications
 * thread (owner.notify's default sink). Registered unconditionally — no provider
 * needed.
 */
export function registerReminderTools(registry: ToolRegistry): ToolRegistry {
  const createSchema = z
    .object({
      text: z.string().min(1).max(500),
      /** A raw 5-field cron, OR the time+weekdays convenience below. */
      cron: z.string().min(9).max(100).optional(),
      time: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM 24-hour')
        .optional(),
      weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    })
    .refine((a) => a.cron || a.time, { message: 'provide a cron expression or a time' });

  register(
    registry,
    {
      name: 'reminder.create',
      description:
        'Create a recurring reminder that pings the owner on a schedule. Give either a 5-field cron, or a time ("HH:MM", owner timezone) with optional weekdays (0=Sun..6=Sat; omit for daily). Use this for "remind me every Friday", not for open-ended work (that is a goal).',
      inputSchema: createSchema,
      risk: 'autonomous',
      acceptsUntrustedInput: false,
      execute: async (args, ctx) => {
        const agent = await getAgent(ctx.db);
        const cron = args.cron ?? cronFromTime(args.time as string, args.weekdays);
        // Validate the cron by computing its next run; nextRun throws if invalid.
        const next = nextRun(cron, agent.timezone);
        const row = await upsertSchedule(ctx.db, {
          agentId: ctx.agentId,
          name: `${REMINDER_PREFIX}${randomUUID()}`,
          cron,
          timezone: agent.timezone,
          taskTemplate: {
            type: 'scheduled',
            job: 'reminder.notify',
            maxSteps: 3,
            budgetUsdLimit: '0.05',
            reminderText: args.text,
            instruction: `Reminder for the owner: ${args.text}\n\nCall owner.notify once with exactly this reminder text, then finish. Do nothing else.`,
            // Fire back into the originating chat when there is one.
            ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
          },
        });
        return { reminderId: row.id, cron, nextFires: next.toISOString(), text: args.text };
      },
    },
    { privateWrite: true },
  );

  register(
    registry,
    {
      name: 'reminder.list',
      description: "List the owner's active recurring reminders and when each next fires.",
      inputSchema: z.object({}),
      risk: 'autonomous',
      acceptsUntrustedInput: false,
      execute: async (_args, ctx) => {
        const rows = await ctx.db
          .select()
          .from(schedules)
          .where(
            and(eq(schedules.agentId, ctx.agentId), like(schedules.name, `${REMINDER_PREFIX}%`)),
          )
          .orderBy(desc(schedules.enabled), schedules.nextRunAt);
        return {
          reminders: rows.map((r) => ({
            reminderId: r.id,
            text: (r.taskTemplate as { reminderText?: string })?.reminderText ?? '',
            cron: r.cron,
            enabled: r.enabled,
            nextFires: r.enabled ? (r.nextRunAt?.toISOString() ?? null) : null,
          })),
        };
      },
    },
    { confidentialRead: true },
  );

  register(
    registry,
    {
      name: 'reminder.cancel',
      description: 'Cancel a recurring reminder by its id (from reminder.list).',
      inputSchema: z.object({ reminderId: z.string().uuid() }),
      risk: 'autonomous',
      acceptsUntrustedInput: false,
      execute: async (args, ctx) => {
        const [updated] = await ctx.db
          .update(schedules)
          .set({ enabled: false, nextRunAt: null, updatedAt: sql`now()` })
          .where(
            and(
              eq(schedules.id, args.reminderId),
              eq(schedules.agentId, ctx.agentId),
              like(schedules.name, `${REMINDER_PREFIX}%`),
            ),
          )
          .returning({ id: schedules.id });
        return { cancelled: Boolean(updated), reminderId: args.reminderId };
      },
    },
    { privateWrite: true },
  );

  return registry;
}
