import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { InstallationStore } from './store.js';

/** Test helpers must never fall through to ADC or a real database. */
export function emulatorStore(now?: () => Date): InstallationStore {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host)) {
    throw new Error('Firestore tests require a loopback FIRESTORE_EMULATOR_HOST');
  }
  return new InstallationStore(
    new Firestore({ projectId: 'demo-assistant-test', databaseId: '(default)' }),
    `test-${randomUUID()}`,
    now,
  );
}

export async function disposeStore(store: InstallationStore): Promise<void> {
  await store.db.recursiveDelete(store.root);
  await store.db.terminate();
}

export async function seedBudget(store: InstallationStore, daily = 1, monthly = 10): Promise<void> {
  await store.doc('coordination', 'budget-policy').set({
    dailyLimitMicros: daily * 1_000_000,
    monthlyLimitMicros: monthly * 1_000_000,
    softPct: 80,
  });
}
