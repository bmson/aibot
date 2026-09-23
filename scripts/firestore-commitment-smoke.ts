import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { InstallationStore } from '@assistant/firestore';
import { FieldPath } from '@google-cloud/firestore';

/** Exercise the mobile commitment overview's exact paged query in real Firestore. */
export async function firestoreCommitmentSmoke(store: InstallationStore) {
  const agentId = randomUUID();
  const openId = randomUUID();
  const snoozedId = randomUUID();
  await Promise.all([
    store.doc('commitments', openId).set({ id: openId, agentId, status: 'open' }),
    store.doc('commitments', snoozedId).set({ id: snoozedId, agentId, status: 'snoozed' }),
  ]);
  const query = (status: string) =>
    store
      .collection('commitments')
      .where('agentId', '==', agentId)
      .where('status', '==', status)
      .orderBy(FieldPath.documentId())
      .limit(200)
      .get();
  const [open, snoozed] = await Promise.all([query('open'), query('snoozed')]);
  assert.deepEqual(
    open.docs.map((doc) => doc.id),
    [store.doc('commitments', openId).id],
  );
  assert.deepEqual(
    snoozed.docs.map((doc) => doc.id),
    [store.doc('commitments', snoozedId).id],
  );
  return { open: open.size, snoozed: snoozed.size };
}
