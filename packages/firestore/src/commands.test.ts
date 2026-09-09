import { randomUUID } from 'node:crypto';
import type { Records } from '@assistant/persistence';
import { commandContract, taskFixture } from '@assistant/persistence/testing';
import { FirestoreCostRepository } from './costs.js';
import { FirestoreMessageRepository } from './messages.js';
import { FirestoreReminderRepository } from './reminders.js';
import { decodeRecord } from './store.js';
import { FirestoreTaskRepository } from './task-lifecycle.js';
import { disposeStore, emulatorStore, seedBudget } from './test-store.js';

commandContract(
  'Firestore persistence contract',
  async () => {
    const store = emulatorStore();
    const agentId = randomUUID(),
      taskId = randomUUID(),
      conversationId = randomUUID(),
      reminderId = randomUUID();
    await seedBudget(store);
    await store.doc('conversations', conversationId).set({ id: conversationId, agentId });
    await store.doc('schedules', reminderId).set({
      id: reminderId,
      agentId,
      name: `reminder:${reminderId}`,
      enabled: true,
      taskTemplate: { reminderKind: 'once', reminderText: 'contract' },
    });
    await store
      .doc('tasks', taskId)
      .set(taskFixture({ id: taskId, agentId, conversationId, reminderId }));
    return {
      externalCounts: async () => ({ hour: 0, day: 0 }),
      setTaskRatePolicy: async (hour, day) => {
        await store.doc('rateLimits', 'task').set({ maxPerHour: hour, maxPerDay: day });
      },
      agentId,
      taskId,
      conversationId,
      reminderId,
      costs: new FirestoreCostRepository(store),
      leases: new FirestoreTaskRepository(store),
      messages: new FirestoreMessageRepository(store),
      reminders: new FirestoreReminderRepository(store),
      patchTask: async (patch) => {
        await store.doc('tasks', taskId).update(patch);
      },
      readTask: async () =>
        decodeRecord<Records['tasks']>((await store.doc('tasks', taskId).get()).data()),
      messageCount: async () =>
        (await store.collection('messages').where('conversationId', '==', conversationId).get())
          .size,
      dispose: () => disposeStore(store),
    };
  },
  !process.env.FIRESTORE_EMULATOR_HOST,
);
