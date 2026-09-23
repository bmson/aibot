import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreSkillMutationRepository } from './skill-mutations.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore skill mutations', () => {
  let store: InstallationStore;
  let repository: FirestoreSkillMutationRepository;
  const agentId = randomUUID();
  const space = {
    provider: 'vertex',
    model: 'fixture-embedding',
    dimensions: 1536,
    revision: 'skill-mutation-test-v1',
  };
  const embedding = Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0));
  const input = {
    name: 'Flight booking',
    preconditions: '',
    steps: 'Compare fares and book the selected flight.',
    gotchas: '',
  };

  beforeEach(async () => {
    store = emulatorStore();
    repository = new FirestoreSkillMutationRepository(store, space);
    await store.doc('agents', agentId).set({ id: agentId });
  });

  afterEach(async () => disposeStore(store));

  it('accepts the 500th skill and refuses a 501st new skill', async () => {
    const batch = store.db.batch();
    for (let index = 0; index < 499; index++) {
      const id = randomUUID();
      batch.set(store.doc('skills', id), {
        id,
        agentId,
        name: `Existing ${index}`,
        preconditions: '',
        steps: 'Existing steps',
        gotchas: '',
        embedding: null,
        sourceTaskId: null,
        originTrust: 'assistant',
        ownerAuthored: false,
        useCount: 0,
        successCount: 0,
        failureCount: 0,
        lastVerifiedAt: null,
        deprecated: false,
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
        updatedAt: new Date('2026-09-01T00:00:00.000Z'),
      });
    }
    await batch.commit();

    await repository.saveOwner(agentId, input, embedding);
    const afterInsert = await store.collection('skills').where('agentId', '==', agentId).get();
    expect(afterInsert.size).toBe(500);
    expect(afterInsert.docs.some((doc) => doc.get('name') === input.name)).toBe(true);
    await expect(
      repository.saveOwner(agentId, { ...input, name: 'One too many' }, embedding),
    ).rejects.toThrow('Learned-skill library exceeds the mobile workspace limit');
  });

  it('fails closed when a same-name document stores a different skill ID', async () => {
    const mismatchedId = randomUUID();
    await store.doc('skills', 'malformed-skill-document').set({
      id: mismatchedId,
      agentId,
      name: input.name,
      preconditions: '',
      steps: 'Existing steps',
      gotchas: '',
      embedding: null,
      sourceTaskId: null,
      originTrust: 'assistant',
      ownerAuthored: false,
      useCount: 0,
      successCount: 0,
      failureCount: 0,
      lastVerifiedAt: null,
      deprecated: false,
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    });

    await expect(repository.saveOwner(agentId, input, embedding)).rejects.toThrow(
      'Invalid learned-skill document',
    );
    const skills = await store.collection('skills').where('agentId', '==', agentId).get();
    expect(skills.size).toBe(1);
    expect(skills.docs[0]?.get('id')).toBe(mismatchedId);
  });
});
