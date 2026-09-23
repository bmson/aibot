import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { InstallationStore } from '@assistant/firestore';

/** Exercise the mobile cost dashboard's descending held-reservation query on real Firestore. */
export async function firestoreMobileCostsSmoke(store: InstallationStore) {
  const olderId = randomUUID();
  const newerId = randomUUID();
  const releasedId = randomUUID();
  await Promise.all([
    store.doc('costReservations', olderId).set({
      id: olderId,
      status: 'held',
      createdAt: new Date('2026-09-22T09:00:00.000Z'),
    }),
    store.doc('costReservations', newerId).set({
      id: newerId,
      status: 'held',
      createdAt: new Date('2026-09-22T10:00:00.000Z'),
    }),
    store.doc('costReservations', releasedId).set({
      id: releasedId,
      status: 'released',
      createdAt: new Date('2026-09-22T11:00:00.000Z'),
    }),
  ]);
  const held = await store
    .collection('costReservations')
    .where('status', '==', 'held')
    .orderBy('createdAt', 'desc')
    .get();
  assert.deepEqual(
    held.docs.map((doc) => doc.id),
    [newerId, olderId],
  );
  return { heldReservationOrder: held.docs.length };
}
