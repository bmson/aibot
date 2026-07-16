import { type Db, type ScheduleRow, schedules } from '@assistant/db';
import { Cron } from 'croner';
import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { InboundEventSchema } from '../events.js';
import { enqueueTask, type TaskType } from './machine.js';

/** Compute the next firing of a cron expression in the given timezone. */
export function nextRun(cron: string, timezone: string, from: Date = new Date()): Date {
  const next = new Cron(cron, { timezone }).nextRun(from);
  if (!next) throw new Error(`cron never fires: ${cron}`);
  return next;
}

/**
 * Tick due schedules: create one task per firing (idempotent via
 * externalEventId schedule:<id>:<next_run_at>) and advance next_run_at.
 * Runs from the sweeper/poller — at-least-once safe.
 */
export async function runDueSchedules(
  db: Db,
  agentTimezone: string,
): Promise<Array<{ schedule: string; taskId: string }>> {
  // Initialize next_run_at for fresh rows
  const uninitialized = await db
    .select()
    .from(schedules)
    .where(and(eq(schedules.enabled, true), isNull(schedules.nextRunAt)));
  for (const row of uninitialized) {
    await db
      .update(schedules)
      .set({ nextRunAt: nextRun(row.cron, agentTimezone), updatedAt: sql`now()` })
      .where(eq(schedules.id, row.id));
  }

  const due = await db
    .select()
    .from(schedules)
    .where(
      and(
        eq(schedules.enabled, true),
        or(isNull(schedules.nextRunAt), lte(schedules.nextRunAt, sql`now()`)),
      ),
    );

  const fired: Array<{ schedule: string; taskId: string }> = [];
  for (const row of due) {
    const firing = row.nextRunAt ?? new Date();
    const template = (row.taskTemplate ?? {}) as {
      type?: TaskType;
      instruction?: string;
      budgetUsdLimit?: string;
      maxSteps?: number;
    };
    const event = InboundEventSchema.parse({
      source: 'schedule',
      externalEventId: `schedule:${row.id}:${firing.toISOString()}`,
      agentId: row.agentId,
      trust: 'assistant',
      payload: { schedule: row.name, instruction: template.instruction ?? row.name },
    });
    const { task, created } = await enqueueTask(db, {
      event,
      type: template.type ?? 'scheduled',
      budgetUsdLimit: template.budgetUsdLimit,
      maxSteps: template.maxSteps,
    });
    if (created) fired.push({ schedule: row.name, taskId: task.id });

    await db
      .update(schedules)
      .set({
        lastRunAt: sql`now()`,
        nextRunAt: nextRun(row.cron, agentTimezone),
        updatedAt: sql`now()`,
      })
      .where(eq(schedules.id, row.id));
  }
  return fired;
}

/** Convenience for seeding/creating schedules with a computed first firing. */
export async function upsertSchedule(
  db: Db,
  input: {
    agentId: string;
    name: string;
    cron: string;
    timezone: string;
    taskTemplate: Record<string, unknown>;
    enabled?: boolean;
  },
): Promise<ScheduleRow> {
  const existing = await db
    .select()
    .from(schedules)
    .where(and(eq(schedules.agentId, input.agentId), eq(schedules.name, input.name)));
  if (existing[0]) return existing[0];
  const [row] = await db
    .insert(schedules)
    .values({
      agentId: input.agentId,
      name: input.name,
      cron: input.cron,
      taskTemplate: input.taskTemplate,
      enabled: input.enabled ?? true,
      nextRunAt: nextRun(input.cron, input.timezone),
    })
    .returning();
  if (!row) throw new Error('schedule upsert failed');
  return row;
}
