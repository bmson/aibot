import { registerReminderTools } from '@assistant/tools/reminders';
import { defineModule } from '../platform.js';
import { remindersMeta } from './meta.js';

export const remindersModule = defineModule({
  meta: remindersMeta,
  create: ({ registry }) => {
    registerReminderTools(registry);
    return {};
  },
});
