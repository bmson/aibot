import type { Records } from './records.js';

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

export function reminderScheduleIsActive(row: Records['schedules']): boolean {
  const template = reminderScheduleTemplate(row.taskTemplate);
  if (template.reminderCancelledAt || template.reminderDeliveredAt) return false;
  return template.reminderKind === 'once' || row.enabled;
}
