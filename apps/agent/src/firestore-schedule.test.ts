import { randomUUID } from 'node:crypto';
import { createInstallationStore, type InstallationStore } from '@assistant/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { firestoreScheduleSmoke } from '../../../scripts/firestore-schedule-smoke.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore scheduling', () => {
  let store: InstallationStore;

  beforeEach(() => {
    vi.stubEnv('METADATA_SERVER_DETECTION', 'none');
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? ''))
      throw new Error('Requires a loopback emulator');
    store = createInstallationStore({
      projectId: 'demo-assistant-test',
      installationId: `test-${randomUUID()}`,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllEnvs();
  });

  it('rehearses atomic schedule firing, reminder delivery, and cancellation races', async () => {
    const report = await firestoreScheduleSmoke(store);
    expect(report).toMatchObject({
      reminderManagement: 'passed',
      oneTimeAtomicFiring: 'passed',
      oneTimeDeliveryFence: 'passed',
      recurringAdvancement: 'passed',
      cancellationRace: 'passed',
      staleSnapshotFence: 'passed',
    });
  }, 60_000);
});
