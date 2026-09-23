import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FirestoreProfilePeopleReadRepository, type InstallationStore } from '@assistant/firestore';

/** Exercise profile fact and occasion indexes in a fresh real Firestore database. */
export async function firestoreProfilePeopleSmoke(store: InstallationStore) {
  const agentId = randomUUID();
  const contactId = randomUUID();
  const memoryId = randomUUID();
  const occasionId = randomUUID();
  const now = store.now();
  await Promise.all([
    store.doc('memories', memoryId).set({
      id: memoryId,
      agentId,
      subjectContactId: contactId,
      category: 'knowledge',
      quarantined: false,
      expiresAt: null,
      pinned: false,
      importance: 3,
      confidence: '0.80',
      createdAt: now,
    }),
    store.doc('occasions', occasionId).set({
      id: occasionId,
      agentId,
      contactId,
      kind: 'birthday',
      label: 'Validation birthday',
      month: 3,
      day: 14,
      createdAt: now,
    }),
  ]);
  const repository = new FirestoreProfilePeopleReadRepository(store, agentId);
  const [facts, occasions] = await Promise.all([
    repository.getFacts(contactId, 1),
    repository.listOccasions(contactId),
  ]);
  assert.deepEqual(
    facts.rows.map((row) => row.id),
    [memoryId],
  );
  assert.equal(facts.total, 1);
  assert.deepEqual(
    occasions.map((row) => row.id),
    [occasionId],
  );
  return { facts: facts.total, occasions: occasions.length };
}
