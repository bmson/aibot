import { randomUUID } from 'node:crypto';
import {
  cancelNamedReminder,
  getAgent,
  listReminderSchedules,
  nextRun,
  reminderScheduleIsActive,
  reminderScheduleTemplate,
  upsertSchedule,
} from '@assistant/core';
import { z } from 'zod';
import type { ToolRegistry } from './registry.js';
import type { AssistantTool, ToolFlags } from './types.js';

const REMINDER_PREFIX = 'reminder:';
/** A valid placeholder cron for a one-time row; nextRunAt remains authoritative. */
function cronForInstant(at: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((entry) => entry.type === type)?.value ?? 0);
  return `${part('minute')} ${part('hour')} ${part('day')} ${part('month')} *`;
}

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
      /** Exact instant for a reminder that fires once. */
      at: z.string().datetime({ offset: true }).optional(),
      /** Relative one-time delay, resolved by the server clock. */
      inMinutes: z
        .number()
        .int()
        .min(1)
        .max(7 * 24 * 60)
        .optional(),
    })
    .superRefine((args, refinement) => {
      const oneTimeInputs = Number(Boolean(args.at)) + Number(Boolean(args.inMinutes));
      const recurringInputs = Number(Boolean(args.cron)) + Number(Boolean(args.time));
      if (oneTimeInputs + recurringInputs > 1) {
        refinement.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'provide exactly one reminder schedule: at/inMinutes, cron, or time',
        });
      } else if (oneTimeInputs + recurringInputs !== 1) {
        refinement.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'provide exactly one of at, inMinutes, cron, or time',
        });
      }
    });

  register(
    registry,
    {
      name: 'reminder.create',
      description:
        'Create a reminder. Ordinary requests such as "remind me tomorrow at 9" fire ONCE: pass an ISO 8601 instant with offset in at, or inMinutes for "in 10 minutes" so the server resolves the delay against the owner clock. Only when the owner explicitly asks to repeat should you pass a 5-field cron, or time ("HH:MM", owner timezone) with optional weekdays (0=Sun..6=Sat; omit only for explicitly daily reminders). Open-ended work is a goal, not a reminder.',
      inputSchema: createSchema,
      risk: 'autonomous',
      acceptsUntrustedInput: false,
      execute: async (args, ctx) => {
        const agent = await getAgent(ctx.db);
        const relativeFiresAt = args.inMinutes
          ? new Date(ctx.now().getTime() + args.inMinutes * 60 * 1000)
          : undefined;
        const oneTimeAt = args.at ? new Date(args.at) : relativeFiresAt;
        if (oneTimeAt) {
          const firesAt = oneTimeAt;
          if (firesAt.getTime() <= ctx.now().getTime()) {
            throw new Error('one-time reminder must be in the future');
          }
          const cron = cronForInstant(firesAt, agent.timezone);
          const row = await upsertSchedule(ctx.db, {
            agentId: ctx.agentId,
            name: `${REMINDER_PREFIX}${randomUUID()}`,
            cron,
            timezone: agent.timezone,
            nextRunAt: firesAt,
            taskTemplate: {
              type: 'scheduled',
              job: 'reminder.notify',
              maxSteps: 3,
              budgetUsdLimit: '0.05',
              reminderKind: 'once',
              reminderText: args.text,
              timezone: agent.timezone,
              instruction: `Reminder for the owner: ${args.text}\n\nCall owner.notify once with exactly this reminder text, then finish. Do nothing else.`,
              ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
            },
          });
          return {
            reminderId: row.id,
            kind: 'once' as const,
            nextFires: firesAt.toISOString(),
            timezone: agent.timezone,
            text: args.text,
          };
        }
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
            reminderKind: 'recurring',
            timezone: agent.timezone,
            reminderText: args.text,
            instruction: `Reminder for the owner: ${args.text}\n\nCall owner.notify once with exactly this reminder text, then finish. Do nothing else.`,
            // Fire back into the originating chat when there is one.
            ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
          },
        });
        return {
          reminderId: row.id,
          kind: 'recurring' as const,
          cron,
          nextFires: next.toISOString(),
          timezone: agent.timezone,
          text: args.text,
        };
      },
    },
    { privateWrite: true },
  );

  register(
    registry,
    {
      name: 'reminder.list',
      description: "List the owner's active one-time and recurring reminders and when each fires.",
      inputSchema: z.object({}),
      risk: 'autonomous',
      acceptsUntrustedInput: false,
      execute: async (_args, ctx) => {
        const agent = await getAgent(ctx.db);
        const rows = await listReminderSchedules(ctx.db, ctx.agentId);
        rows.sort(
          (a, b) =>
            Number(b.enabled) - Number(a.enabled) ||
            (a.nextRunAt?.getTime() ?? Number.POSITIVE_INFINITY) -
              (b.nextRunAt?.getTime() ?? Number.POSITIVE_INFINITY) ||
            a.id.localeCompare(b.id),
        );
        return {
          reminders: rows.filter(reminderScheduleIsActive).map((r) => ({
            reminderId: r.id,
            text: reminderScheduleTemplate(r.taskTemplate).reminderText ?? '',
            kind: reminderScheduleTemplate(r.taskTemplate).reminderKind ?? 'recurring',
            cron: r.cron,
            timezone: agent.timezone,
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
      description:
        'Remove a reminder by id or by the owner\'s words, such as "the sunglasses reminder". Prefer query when the owner names the reminder naturally. A unique exact or partial text match is cancelled; ambiguous matches are returned so you can ask which one. Never say it was removed unless cancelled is true.',
      inputSchema: z
        .object({
          reminderId: z.string().uuid().optional(),
          query: z.string().min(1).max(500).optional(),
        })
        .refine((args) => Boolean(args.reminderId) !== Boolean(args.query), {
          message: 'provide exactly one of reminderId or query',
        }),
      risk: 'autonomous',
      acceptsUntrustedInput: false,
      execute: async (args, ctx) => {
        return cancelNamedReminder(ctx.db, ctx.agentId, args, ctx.now());
      },
    },
    { privateWrite: true },
  );

  return registry;
}
