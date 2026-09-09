import { createPostgresReminderRepository, type Db } from '@assistant/db';
import type { ReminderRepository } from '@assistant/persistence';

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
