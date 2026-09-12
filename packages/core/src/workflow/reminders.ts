import { createPostgresReminderRepository, type Db } from '@assistant/db';
import {
  REMINDER_SCHEDULE_PREFIX,
  type ReminderRepository,
  reminderScheduleIsActive,
  reminderScheduleTemplate,
  type ScheduleRepository,
} from '@assistant/persistence';
import { listOwnerSchedules } from './schedules.js';

export {
  REMINDER_SCHEDULE_PREFIX,
  type ReminderScheduleTemplate,
  reminderScheduleIsActive,
  reminderScheduleTemplate,
} from '@assistant/persistence';

/** Cancel is one atomic command; the adapter owns coordination with delivery. */
export function cancelReminderSchedule(
  store: Db | ReminderRepository,
  agentId: string,
  reminderId: string,
  now = new Date(),
) {
  const repository =
    'kind' in store && store.kind === 'reminder-repository'
      ? (store as ReminderRepository)
      : createPostgresReminderRepository(store as Db);
  return repository.cancel(agentId, reminderId, now);
}

export interface ReminderManagementStore {
  schedules: ScheduleRepository;
  reminders: ReminderRepository;
}

export async function listReminderSchedules(store: Db | ScheduleRepository, agentId: string) {
  return (await listOwnerSchedules(store, agentId)).filter((row) =>
    row.name.startsWith(REMINDER_SCHEDULE_PREFIX),
  );
}

function normalizeReminderText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\b(?:the|a|an|reminder)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Resolve the owner's words completely before invoking the authoritative cancellation command. */
export async function cancelNamedReminder(
  store: Db | ReminderManagementStore,
  agentId: string,
  input: { reminderId?: string; query?: string },
  now = new Date(),
) {
  if (Boolean(input.reminderId) === Boolean(input.query))
    throw new Error('Provide exactly one reminder ID or query');
  const portable = 'reminders' in store;
  const reminderStore = portable ? store.reminders : store;
  let reminderId = input.reminderId;
  if (!reminderId) {
    const query = normalizeReminderText(input.query ?? '');
    if (!query) return { cancelled: false as const, reason: 'not_found' as const };
    const rows = await listReminderSchedules(portable ? store.schedules : store, agentId);
    const active = rows.filter(reminderScheduleIsActive);
    const textFor = (row: (typeof rows)[number]) =>
      normalizeReminderText(reminderScheduleTemplate(row.taskTemplate).reminderText ?? '');
    const exact = active.filter((row) => textFor(row) === query);
    const matches = exact.length
      ? exact
      : active.filter((row) => {
          const text = textFor(row);
          return text.length > 0 && (text.includes(query) || query.includes(text));
        });
    if (!matches.length) return { cancelled: false as const, reason: 'not_found' as const };
    if (matches.length > 1)
      return {
        cancelled: false as const,
        reason: 'ambiguous' as const,
        matches: matches.map((row) => ({
          reminderId: row.id,
          text: reminderScheduleTemplate(row.taskTemplate).reminderText ?? '',
          nextFires: row.nextRunAt?.toISOString() ?? null,
        })),
      };
    reminderId = matches[0]?.id;
  }
  if (!reminderId) return { cancelled: false as const, reason: 'not_found' as const };
  const result = await cancelReminderSchedule(reminderStore, agentId, reminderId, now);
  if (!result.cancelled) return { cancelled: false as const, reason: 'not_found' as const };
  return {
    cancelled: true as const,
    reminderId,
    text: result.text ?? '',
    queuedTasksCancelled: result.queuedTasksCancelled ?? 0,
  };
}
