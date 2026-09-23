import { FirestoreApprovalPolicyRepository } from './approval-policies.js';
import { FirestoreReminderRepository } from './reminders.js';
import { FirestoreScheduleRepository } from './schedules.js';
import { FirestoreSettingsRepository } from './settings.js';
import type { InstallationStore } from './store.js';

/** A complete settings facade for the configured installation owner. */
export function createFirestoreSettingsPersistence(store: InstallationStore, agentId: string) {
  if (!agentId) throw new Error('Settings require a configured agent');
  return {
    kind: 'settings-persistence' as const,
    settings: new FirestoreSettingsRepository(store, agentId),
    schedules: new FirestoreScheduleRepository(store),
    reminders: new FirestoreReminderRepository(store),
    policies: new FirestoreApprovalPolicyRepository(store),
  };
}
