import type { AppendMessageInput, TaskLease } from '@assistant/persistence';
import { taskFixture } from '@assistant/persistence/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreReminderRepository } from './reminders.js';
import type { InstallationStore } from './store.js';
import { FirestoreTaskLeaseRepository } from './tasks.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore reminder delivery fence', () => {
  let store: InstallationStore;
  let reminders: FirestoreReminderRepository;
  let lease: TaskLease;
  let now: Date;
  const message: AppendMessageInput = {
    conversationId: 'conversation',
    taskId: 'task',
    role: 'assistant',
    origin: 'assistant',
    text: 'remember',
    parts: [{ type: 'text', text: 'remember' }],
  };
  beforeEach(async () => {
    now = new Date();
    store = emulatorStore(() => now);
    reminders = new FirestoreReminderRepository(store);
    await store.doc('conversations', 'conversation').set({ id: 'conversation', agentId: 'agent' });
    await store.doc('schedules', 'reminder').set({
      id: 'reminder',
      agentId: 'agent',
      name: 'reminder:test',
      enabled: true,
      taskTemplate: { reminderKind: 'recurring' },
    });
    await store.doc('tasks', 'task').set({
      ...taskFixture({
        id: 'task',
        agentId: 'agent',
        conversationId: 'conversation',
        reminderId: 'reminder',
      }),
      externalEventId: 'schedule:reminder:one',
      trigger: {
        payload: {
          scheduleId: 'reminder',
          occurrenceId: 'schedule:reminder:one',
        },
      },
    });
    const claimed = await new FirestoreTaskLeaseRepository(store).claim('task');
    if (!claimed) throw new Error('Fixture claim failed');
    lease = claimed;
  });
  afterEach(async () => {
    await disposeStore(store);
  });
  const deliver = () =>
    reminders.deliver({
      agentId: 'agent',
      reminderId: 'reminder',
      occurrenceId: 'schedule:reminder:one',
      lease,
      message,
    });
  it('a cancelled reminder cannot publish after cancellation, even with a running worker', async () => {
    expect((await reminders.cancel('agent', 'reminder')).cancelled).toBe(true);
    expect(await deliver()).toBe(false);
    expect((await store.collection('messages').get()).size).toBe(0);
  });
  it('delivery and cancellation races produce one truthful outcome', async () => {
    const [delivered, cancelled] = await Promise.all([
      deliver(),
      reminders.cancel('agent', 'reminder'),
    ]);
    expect(Number(delivered) + Number(cancelled.cancelled)).toBe(1);
    expect((await store.collection('messages').get()).size).toBe(Number(delivered));
  }, 20_000);
  it('duplicate occurrences never append a second notification', async () => {
    const results = await Promise.all([deliver(), deliver()]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await store.collection('messages').get()).size).toBe(1);
  }, 20_000);
  it('rejects a different occurrence on the same recurring task', async () => {
    expect(
      await reminders.deliver({
        agentId: 'agent',
        reminderId: 'reminder',
        occurrenceId: 'schedule:reminder:two',
        lease,
        message,
      }),
    ).toBe(false);
    expect((await store.collection('messages').get()).size).toBe(0);
  });
  it('expired and replaced leases cannot deliver', async () => {
    now = new Date(now.getTime() + 11 * 60_000);
    expect(await deliver()).toBe(false);
    const replacement = await new FirestoreTaskLeaseRepository(store).claim('task');
    expect(replacement).not.toBeNull();
    expect(await deliver()).toBe(false);
  });
});
