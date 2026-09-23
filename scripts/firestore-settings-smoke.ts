import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FirestoreSettingsRepository, type InstallationStore } from '@assistant/firestore';

/** Exercise the held-ping composite index in a fresh real Firestore database. */
export async function firestoreSettingsSmoke(store: InstallationStore) {
  const agentId = randomUUID();
  const since = new Date(Date.now() - 3_600_000);
  const rows = [
    { id: randomUUID(), delivered: false, reason: 'quiet-hours', createdAt: since },
    {
      id: randomUUID(),
      delivered: false,
      reason: 'daily-cap',
      createdAt: new Date(since.getTime() - 1),
    },
    {
      id: randomUUID(),
      delivered: true,
      reason: 'daily-cap',
      createdAt: new Date(since.getTime() + 1),
    },
  ];
  await Promise.all(
    rows.map((row) =>
      store.doc('proactivePings', row.id).set({
        ...row,
        agentId,
        channel: 'in_app',
        urgency: 'ambient',
      }),
    ),
  );
  const heldLast24h = await new FirestoreSettingsRepository(store).countHeldPings(agentId, since);
  assert.deepEqual(heldLast24h, { quietHours: 1, dailyCap: 0 });
  return { heldLast24h };
}
