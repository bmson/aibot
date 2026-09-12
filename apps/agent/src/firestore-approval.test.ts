import { randomUUID } from 'node:crypto';
import { createInstallationStore, type InstallationStore } from '@assistant/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { firestoreApprovalSmoke } from '../../../scripts/firestore-approval-smoke.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore approval maintenance', () => {
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

  it('rehearses approval creation, notices, expiry and pre-park recovery', async () => {
    const report = await firestoreApprovalSmoke(store);
    expect(report).toMatchObject({
      policyManagement: 'passed',
      approvalCreation: 'passed',
      notificationRepair: 'passed',
      approvalExpiry: 'passed',
      preParkRecovery: 'passed',
      generationFences: 'passed',
      durableWakeIntents: 'passed',
    });
  }, 60_000);
});
