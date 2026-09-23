import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FirestoreProfilePeopleCommandRepository } from './profile-people-command.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore profile people command', () => {
  it('creates and edits only contacts owned by the configured installation owner', async () => {
    const store = emulatorStore();
    const agentId = randomUUID();
    const foreignAgentId = randomUUID();
    const legacyContactId = randomUUID();
    await store.doc('agents', agentId).set({ id: agentId });
    await store.doc('contacts', legacyContactId).set({
      id: legacyContactId,
      name: 'Old name',
      relationship: '',
      trust: 'unknown',
      aliases: [],
      emails: [],
      phones: [],
      notes: '',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const foreignContactId = randomUUID();
    await store.doc('contacts', foreignContactId).set({
      id: foreignContactId,
      agentId: foreignAgentId,
      name: 'Foreign name',
      relationship: '',
      trust: 'unknown',
      aliases: [],
      emails: [],
      phones: [],
      notes: '',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const repository = new FirestoreProfilePeopleCommandRepository(store, agentId);

    try {
      const createdId = await repository.create({
        name: 'New person',
        relationship: 'friend',
        aliases: ['N. Person'],
      });
      expect((await store.doc('contacts', createdId).get()).data()).toMatchObject({
        id: createdId,
        agentId,
        name: 'New person',
        relationship: 'friend',
        trust: 'known',
        aliases: ['N. Person'],
        emails: [],
        phones: [],
        notes: '',
      });

      await expect(repository.updateIdentity(legacyContactId, 'New person', [])).rejects.toThrow(
        'A person with that name already exists.',
      );
      await repository.updateIdentity(legacyContactId, 'New name', ['Former name']);
      await repository.updateRelationship(legacyContactId, 'colleague');
      expect((await store.doc('contacts', legacyContactId).get()).data()).toMatchObject({
        name: 'New name',
        aliases: ['Former name', 'Old name'],
        relationship: 'colleague',
        trust: 'known',
      });

      await expect(repository.updateRelationship(foreignContactId, 'friend')).rejects.toThrow(
        'Person not found.',
      );
      await expect(repository.updateIdentity(foreignContactId, 'Changed', [])).rejects.toThrow(
        'Person not found or cannot be renamed.',
      );
      expect((await store.doc('contacts', foreignContactId).get()).get('name')).toBe(
        'Foreign name',
      );
    } finally {
      await disposeStore(store);
    }
  });

  it('fails closed for non-single-owner installs and active erasure', async () => {
    const store = emulatorStore();
    const agentId = randomUUID();
    const secondAgentId = randomUUID();
    await store.doc('agents', agentId).set({ id: agentId });
    const repository = new FirestoreProfilePeopleCommandRepository(store, agentId);

    try {
      await store.doc('privacyErasureJobs', agentId).set({
        agentId,
        generation: randomUUID(),
        status: 'active',
        counts: { memories: 0, graphRelations: 0, writingSamples: 0 },
      });
      await expect(
        repository.create({ name: 'Blocked', relationship: '', aliases: [] }),
      ).rejects.toThrow('Privacy erasure is in progress');
      await store.doc('privacyErasureJobs', agentId).delete();
      await store.doc('agents', secondAgentId).set({ id: secondAgentId });
      await expect(
        repository.create({ name: 'Blocked', relationship: '', aliases: [] }),
      ).rejects.toThrow('exactly one configured owner');
      expect((await store.collection('contacts').get()).empty).toBe(true);
    } finally {
      await disposeStore(store);
    }
  });
});
