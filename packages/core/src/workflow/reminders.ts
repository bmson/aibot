import { type Db, schedules, tasks } from '@assistant/db';
import { and, eq, like, ne, notInArray, or, sql } from 'drizzle-orm';

export const REMINDER_SCHEDULE_PREFIX = 'reminder:';

export interface ReminderScheduleTemplate {
  reminderText?: string;
  reminderKind?: 'once' | 'recurring';
  reminderCancelledAt?: string;
  reminderDeliveredAt?: string;
  [key: string]: unknown;
}

export function reminderScheduleTemplate(value: unknown): ReminderScheduleTemplate {
  return (value ?? {}) as ReminderScheduleTemplate;
}

export function reminderScheduleIsActive(row: typeof schedules.$inferSelect): boolean {
  const template = reminderScheduleTemplate(row.taskTemplate);
  if (template.reminderCancelledAt || template.reminderDeliveredAt) return false;
  return template.reminderKind === 'once' || row.enabled;
}

/** Cancel one reminder and any delivery task that no worker has claimed yet. */
export async function cancelReminderSchedule(
  db: Db,
  agentId: string,
  reminderId: string,
  now: Date = new Date(),
): Promise<{ cancelled: boolean; text?: string; queuedTasksCancelled?: number }> {
  return db.transaction(async (tx) => {
    // The delivery job takes the same transaction-scoped lock. Whichever side
    // wins completes first, so cancel never reports success while an older
    // notification is still able to appear afterward.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${reminderId}))`);
    const [reminder] = await tx
      .select()
      .from(schedules)
      .where(
        and(
          eq(schedules.id, reminderId),
          eq(schedules.agentId, agentId),
          like(schedules.name, `${REMINDER_SCHEDULE_PREFIX}%`),
        ),
      )
      .limit(1);
    if (!reminder || !reminderScheduleIsActive(reminder)) return { cancelled: false };

    const template = reminderScheduleTemplate(reminder.taskTemplate);
    const [updated] = await tx
      .update(schedules)
      .set({
        enabled: false,
        nextRunAt: null,
        taskTemplate: { ...template, reminderCancelledAt: now.toISOString() },
        updatedAt: sql`now()`,
      })
      .where(eq(schedules.id, reminder.id))
      .returning({ id: schedules.id });
    if (!updated) return { cancelled: false };

    const cancelledTasks = await tx
      .update(tasks)
      .set({
        status: 'cancelled',
        progress: 'cancelled because its reminder was removed',
        runAfter: null,
        lockedUntil: null,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(tasks.agentId, agentId),
          ne(tasks.status, 'running'),
          notInArray(tasks.status, ['done', 'failed', 'cancelled']),
          or(
            sql`${tasks.trigger}->'payload'->>'scheduleId' = ${reminder.id}`,
            sql`${tasks.trigger}->'payload'->>'schedule' = ${reminder.name}`,
          ),
        ),
      )
      .returning({ id: tasks.id });
    return {
      cancelled: true,
      text: template.reminderText ?? '',
      queuedTasksCancelled: cancelledTasks.length,
    };
  });
}
