import type { ProfileContact } from '@assistant/persistence';
import { assertPrivacyErasureFenceUnchanged, readPrivacyErasureFence } from './privacy-erasure.js';
import { FirestoreProfilePeopleReadRepository } from './profile-people-read.js';
import { documentKey, type InstallationStore } from './store.js';

async function assertConfiguredOwner(store: InstallationStore, agentId: string): Promise<void> {
  const agents = await store.collection('agents').limit(2).get();
  const owner = agents.docs[0];
  if (
    !agentId ||
    agents.size !== 1 ||
    !owner ||
    owner.get('id') !== agentId ||
    owner.id !== documentKey(agentId)
  )
    throw new Error('People directory requires exactly one configured agent');
}

/** Complete contact directory; richer dossier data is not part of this read. */
export async function getFirestorePeopleDirectory(
  store: InstallationStore,
  configuredAgentId: string,
): Promise<ProfileContact[]> {
  await assertConfiguredOwner(store, configuredAgentId);
  const fence = await readPrivacyErasureFence(store, configuredAgentId);
  const contacts = await new FirestoreProfilePeopleReadRepository(
    store,
    configuredAgentId,
  ).listContacts();
  if (
    contacts.some(
      (contact) =>
        !contact.id ||
        typeof contact.name !== 'string' ||
        typeof contact.relationship !== 'string' ||
        typeof contact.trust !== 'string',
    )
  )
    throw new Error('People directory contains a malformed contact');
  await assertConfiguredOwner(store, configuredAgentId);
  await assertPrivacyErasureFenceUnchanged(store, configuredAgentId, fence);
  return contacts.filter((contact) => contact.trust !== 'owner');
}

/** One saved contact; SQL graph, events, and mutation controls are not available here. */
export async function getFirestorePersonDetail(
  store: InstallationStore,
  configuredAgentId: string,
  contactId: string,
): Promise<ProfileContact | null> {
  await assertConfiguredOwner(store, configuredAgentId);
  const fence = await readPrivacyErasureFence(store, configuredAgentId);
  const contact = await new FirestoreProfilePeopleReadRepository(
    store,
    configuredAgentId,
  ).getContact(contactId);
  if (
    contact &&
    (!contact.id ||
      typeof contact.name !== 'string' ||
      typeof contact.relationship !== 'string' ||
      typeof contact.trust !== 'string')
  )
    throw new Error('People detail contains a malformed contact');
  await assertConfiguredOwner(store, configuredAgentId);
  await assertPrivacyErasureFenceUnchanged(store, configuredAgentId, fence);
  return contact?.trust === 'owner' ? null : contact;
}
