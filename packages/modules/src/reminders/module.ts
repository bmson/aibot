import { registerReminderTools } from '@assistant/tools/reminders';
import { defineModule } from '../platform.js';
import { remindersMeta } from './meta.js';

export const remindersModule = defineModule({
  meta: remindersMeta,
  create: ({ config, registry, portableReminders }) => {
    if (config.PERSISTENCE_DRIVER === 'firestore' && !portableReminders) {
      throw new Error('Firestore reminders require portable reminder persistence');
    }
    registerReminderTools(registry, portableReminders);
    return {};
  },
});
