import { randomUUID } from 'node:crypto';
import { runDueSchedules } from '@assistant/core/workflow/schedules';
import {
  FirestoreScheduleRepository,
  FirestoreSelfRepairRepository,
  type InstallationStore,
} from '@assistant/firestore';
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
  it('wakes new reports and retries atomically, and preserves a disabled schedule', async () => {
    await ensureRepairSchedule(store, agentId);
    const row = (await store.collection('schedules').where('agentId', '==', agentId).get()).docs[0];
    if (!row) throw new Error('Missing schedule');
    const later = new Date(Date.now() + 3600000);
    await row.ref.update({ nextRunAt: later });
    const repairs = new FirestoreSelfRepairRepository(store, agentId);
    const report = {
      fingerprint: 'wake',
      source: 'feedback' as const,
      title: 'Synthetic failure',
      summary: 'Expected a working flow',
    };
    const issue = await repairs.report(agentId, report);
    expect((await row.ref.get()).get('nextRunAt').toMillis()).toBeLessThan(later.getTime());
    const fired = await runDueSchedules(
      new FirestoreScheduleRepository(store),
      'America/Los_Angeles',
      { isJobEnabled: () => true },
    );
    expect(fired).toHaveLength(1);
    const firing = fired[0];
    if (!firing) throw new Error('Missing firing');
    const task = await store.doc('tasks', firing.taskId).get();
    expect(task.get('trigger.payload.job')).toBe('self.repair');
    const wakes = await store.collection('outbox').where('taskId', '==', firing.taskId).get();
    expect(wakes.size).toBe(1);
    const blocked = await repairs.update(issue, 'blocked', {}, new Date());
    await row.ref.update({ nextRunAt: later });
    if (!blocked) throw new Error('Missing blocked issue');
    await repairs.update(blocked, 'reported', {}, new Date());
    expect((await row.ref.get()).get('nextRunAt').toMillis()).toBeLessThan(later.getTime());
    await row.ref.update({ enabled: false, nextRunAt: later });
    await repairs.report(agentId, { ...report, fingerprint: 'disabled' });
    expect((await row.ref.get()).get('nextRunAt').toMillis()).toBe(later.getTime());
  });
  it('recovers waiting work immediately after the rolling allowance returns', async () => {
    await ensureRepairSchedule(store, agentId);
    const schedule = (await store.collection('schedules').where('agentId', '==', agentId).get())
      .docs[0];
    if (!schedule) throw new Error('Missing schedule');
    const repairs = new FirestoreSelfRepairRepository(store, agentId);
    const report = {
      fingerprint: 'used',
      source: 'feedback' as const,
      title: 'Synthetic failure',
      summary: 'Expected a working flow',
    };
    const issue = await repairs.report(agentId, report);
    const dispatched = await repairs.update(issue, 'fixing', {}, new Date());
    if (!dispatched) throw new Error('Missing dispatch');
    await repairs.update(dispatched, 'failed', {}, new Date());
    await repairs.report(agentId, { ...report, fingerprint: 'waiting' });
    const later = new Date(Date.now() + 3600000);
    await schedule.ref.update({ nextRunAt: later });
    await ensureRepairSchedule(store, agentId, 1);
    expect((await schedule.ref.get()).get('nextRunAt').toMillis()).toBe(later.getTime());
    const saved = await store.doc('selfRepairIssues', issue.id).get();
    const data = saved.get('data');
    data.history.find((event: { status: string }) => event.status === 'fixing').at = new Date(
      Date.now() - 86400001,
    ).toISOString();
    await saved.ref.update({ data });
    await ensureRepairSchedule(store, agentId, 1);
    expect((await schedule.ref.get()).get('nextRunAt').toMillis()).toBeLessThan(later.getTime());
    expect((await repairs.claim(agentId, new Date(), 1))?.fingerprint).toBe('waiting');
  });
  it('refuses missing owners and active erasure fences', async () => {
    await expect(ensureRepairSchedule(store, randomUUID())).rejects.toThrow('owner is missing');
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    await expect(ensureRepairSchedule(store, agentId)).rejects.toThrow('Privacy erasure');
  });
});
