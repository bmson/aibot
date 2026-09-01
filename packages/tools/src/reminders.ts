import { randomUUID } from 'node:crypto';
import {
  cancelReminderSchedule,
  getAgent,
  nextRun,
  reminderScheduleIsActive,
  reminderScheduleTemplate,
  upsertSchedule,
} from '@assistant/core';
import { schedules } from '@assistant/db';
import { and, desc, eq, like } from 'drizzle-orm';
import { z } from 'zod';
import type { ToolRegistry } from './registry.js';
import type { AssistantTool, ToolFlags } from './types.js';

const REMINDER_PREFIX = 'reminder:';
function normalizeReminderText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\b(?:the|a|an|reminder)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

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
    })
    .superRefine((args, refinement) => {
      const recurringInputs = Number(Boolean(args.cron)) + Number(Boolean(args.time));
      if (args.at && recurringInputs > 0) {
        refinement.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'provide at for a one-time reminder, or cron/time for a recurring reminder',
        });
      } else if (!args.at && recurringInputs !== 1) {
        refinement.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'provide exactly one of at, cron, or time',
        });
      }
    });

  register(
    registry,
    {
      name: 'reminder.create',
      description:
        'Create a reminder. Ordinary requests such as "remind me tomorrow at 9" fire ONCE: pass an ISO 8601 instant with offset in at. Only when the owner explicitly asks to repeat should you pass a 5-field cron, or time ("HH:MM", owner timezone) with optional weekdays (0=Sun..6=Sat; omit only for explicitly daily reminders). Open-ended work is a goal, not a reminder.',
      inputSchema: createSchema,
      risk: 'autonomous',
      acceptsUntrustedInput: false,
      execute: async (args, ctx) => {
        const agent = await getAgent(ctx.db);
        if (args.at) {
          const firesAt = new Date(args.at);
          if (firesAt.getTime() <= ctx.now().getTime()) {
            throw new Error('one-time reminder must be in the future');
          }
          const cron = cronForInstant(firesAt, agent.timezone);
          const [row] = await ctx.db
            .insert(schedules)
            .values({
              agentId: ctx.agentId,
              name: `${REMINDER_PREFIX}${randomUUID()}`,
              cron,
              nextRunAt: firesAt,
              taskTemplate: {
                type: 'scheduled',
                job: 'reminder.notify',
                maxSteps: 3,
                budgetUsdLimit: '0.05',
                reminderKind: 'once',
                reminderText: args.text,
                instruction: `Reminder for the owner: ${args.text}\n\nCall owner.notify once with exactly this reminder text, then finish. Do nothing else.`,
                ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
              },
            })
            .returning();
          if (!row) throw new Error('reminder creation failed');
          return {
            reminderId: row.id,
            kind: 'once' as const,
            nextFires: firesAt.toISOString(),
            schedule: firesAt.toISOString(),
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
        const rows = await ctx.db
          .select()
          .from(schedules)
          .where(
            and(eq(schedules.agentId, ctx.agentId), like(schedules.name, `${REMINDER_PREFIX}%`)),
          )
          .orderBy(desc(schedules.enabled), schedules.nextRunAt);
        return {
          reminders: rows.filter(reminderScheduleIsActive).map((r) => ({
            reminderId: r.id,
            text: reminderScheduleTemplate(r.taskTemplate).reminderText ?? '',
            kind: reminderScheduleTemplate(r.taskTemplate).reminderKind ?? 'recurring',
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
        const rows = await ctx.db
          .select()
          .from(schedules)
          .where(
            and(eq(schedules.agentId, ctx.agentId), like(schedules.name, `${REMINDER_PREFIX}%`)),
          );
        const active = rows.filter(reminderScheduleIsActive);
        let matches = args.reminderId ? active.filter((row) => row.id === args.reminderId) : [];
        if (args.query) {
          const query = normalizeReminderText(args.query);
          if (!query) return { cancelled: false, reason: 'not_found' as const };
          const exact = active.filter(
            (row) =>
              normalizeReminderText(
                reminderScheduleTemplate(row.taskTemplate).reminderText ?? '',
              ) === query,
          );
          matches =
            exact.length > 0
              ? exact
              : active.filter((row) => {
                  const text = normalizeReminderText(
                    reminderScheduleTemplate(row.taskTemplate).reminderText ?? '',
                  );
                  return text.includes(query) || query.includes(text);
                });
        }
        if (matches.length === 0) {
          return { cancelled: false, reason: 'not_found' as const };
        }
        if (matches.length > 1) {
          return {
            cancelled: false,
            reason: 'ambiguous' as const,
            matches: matches.map((row) => ({
              reminderId: row.id,
              text: reminderScheduleTemplate(row.taskTemplate).reminderText ?? '',
              nextFires: row.nextRunAt?.toISOString() ?? null,
            })),
          };
        }
        const reminder = matches[0] as (typeof matches)[number];
        const result = await cancelReminderSchedule(ctx.db, ctx.agentId, reminder.id, ctx.now());
        if (!result.cancelled) return { cancelled: false, reason: 'not_found' as const };
        return {
          cancelled: true,
          reminderId: reminder.id,
          text: result.text ?? '',
          queuedTasksCancelled: result.queuedTasksCancelled ?? 0,
        };
      },
    },
    { privateWrite: true },
  );

  return registry;
}
