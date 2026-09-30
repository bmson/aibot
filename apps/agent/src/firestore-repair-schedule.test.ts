import { randomUUID } from 'node:crypto';
import type { InstallationStore } from '@assistant/firestore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';
import { ensureRepairSchedule } from './repair-schedule.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('repair schedule provisioning', () => {
  let store: InstallationStore;
  const agentId = randomUUID();
  beforeEach(async () => {
    store = emulatorStore();
    await store.doc('agents', agentId).set({ id: agentId });
  });
  afterEach(async () => disposeStore(store));
  it('creates one schedule under concurrent sweeps and preserves owner disablement', async () => {
    await Promise.all([ensureRepairSchedule(store, agentId), ensureRepairSchedule(store, agentId)]);
    const rows = await store.collection('schedules').where('agentId', '==', agentId).get();
    expect(rows.size).toBe(1);
    const row = rows.docs[0];
    if (!row) throw new Error('Missing repair schedule');
    expect(row.get('taskTemplate.job')).toBe('self.repair');
    await row.ref.update({ enabled: false });
    await ensureRepairSchedule(store, agentId);
    expect((await row.ref.get()).get('enabled')).toBe(false);
  });
  it('refuses missing owners and active erasure fences', async () => {
    await expect(ensureRepairSchedule(store, randomUUID())).rejects.toThrow('owner is missing');
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    await expect(ensureRepairSchedule(store, agentId)).rejects.toThrow('Privacy erasure');
  });
});
