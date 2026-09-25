import { randomUUID } from 'node:crypto';
import { nudgePolicyContract } from '@assistant/persistence/testing';
import { expect, it } from 'vitest';
import { FirestoreNudgePolicyRepository } from './nudge-policy.js';
import { decodeRecord } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

const emulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

nudgePolicyContract(
  'Firestore nudge policy contract',
  async () => {
    const store = emulatorStore();
    const agentId = randomUUID();
    await store.doc('agents', agentId).set({ id: agentId, timezone: 'Atlantic/Reykjavik' });
    return {
      agentId,
      repository: new FirestoreNudgePolicyRepository(store, agentId),
      async setPrefs(prefs) {
        const ref = store.doc('notificationPrefs', agentId);
        if (!prefs) {
          await ref.delete();
          return;
        }
        const now = new Date();
        await ref.set({
          agentId,
          quietStartMin: prefs.quietStartMin ?? null,
          quietEndMin: prefs.quietEndMin ?? null,
          ambientDailyCap: prefs.ambientDailyCap ?? null,
          createdAt: now,
          updatedAt: now,
        });
      },
      async pings() {
        const rows = await store.collection('proactivePings').where('agentId', '==', agentId).get();
        return rows.docs.map((doc) => {
          const row = decodeRecord<{
            urgency: string;
            channel: string;
            delivered: boolean;
            reason: string | null;
            createdAt: Date;
          }>(doc.data());
          return {
            urgency: row.urgency,
            channel: row.channel,
            delivered: row.delivered,
            reason: row.reason,
            createdAt: row.createdAt,
          };
        });
      },
      dispose: () => disposeStore(store),
    };
  },
  !emulator,
);

it.skipIf(!emulator)('refuses an owner other than the configured one', async () => {
  const store = emulatorStore();
  try {
    const agentId = randomUUID();
    const foreignId = randomUUID();
    await store.doc('agents', agentId).set({ id: agentId });
    await store.doc('agents', foreignId).set({ id: foreignId });
    const repository = new FirestoreNudgePolicyRepository(store, agentId);
    await expect(
      repository.evaluate({ id: foreignId, timezone: 'UTC' }, { urgency: 'interrupt' }),
    ).rejects.toThrow('configured agent');
    expect((await store.collection('proactivePings').get()).empty).toBe(true);
  } finally {
    await disposeStore(store);
  }
});
