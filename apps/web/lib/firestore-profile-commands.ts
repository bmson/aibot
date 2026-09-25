import {
  deletePersonWithRepository,
  mergePeopleWithRepository,
  recompileProfileCard,
} from '@assistant/application/profile';
import {
  loadConfig,
  parseFirestoreEmbeddingSpace,
  validateAgentPersistenceConfig,
} from '@assistant/config';
import {
  createFirestoreProfileMemoryCommandPersistence,
  FirestoreOwnerCardCompilationRepository,
  FirestoreProfileOccasionCommandRepository,
  FirestoreProfilePeopleCommandRepository,
  FirestoreProfilePeopleRemovalRepository,
} from '@assistant/firestore';
import { getFirestoreInstallationStore } from '@/lib/server';

export function getFirestoreProfileCommands() {
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER !== 'firestore')
    throw new Error('Firestore profile commands require Firestore persistence');
  const problems = validateAgentPersistenceConfig(config);
  if (problems.length) throw new Error(problems.join('; '));
  const store = getFirestoreInstallationStore();
  return {
    agentId: config.FIRESTORE_AGENT_ID,
    store,
    people: new FirestoreProfilePeopleCommandRepository(store, config.FIRESTORE_AGENT_ID),
    occasions: new FirestoreProfileOccasionCommandRepository(store, config.FIRESTORE_AGENT_ID),
    ownerCards: new FirestoreOwnerCardCompilationRepository(store),
    removal: new FirestoreProfilePeopleRemovalRepository(store, config.FIRESTORE_AGENT_ID),
    memory: createFirestoreProfileMemoryCommandPersistence(
      store,
      parseFirestoreEmbeddingSpace(config.FIRESTORE_EMBEDDING_SPACE),
    ),
  };
}

/** Delete a non-owner person, their facts, and their occasions in Firestore. */
export function deleteFirestorePerson(contactId: string) {
  const commands = getFirestoreProfileCommands();
  return deletePersonWithRepository(commands.removal, commands.memory, commands.agentId, contactId);
}

/** Merge one person into another in Firestore. */
export function mergeFirestorePeople(sourceId: string, targetId: string) {
  const commands = getFirestoreProfileCommands();
  return mergePeopleWithRepository(
    commands.removal,
    commands.ownerCards,
    commands.agentId,
    sourceId,
    targetId,
  );
}

export function recompileFirestoreProfileCard(
  commands: ReturnType<typeof getFirestoreProfileCommands>,
) {
  return recompileProfileCard(commands.ownerCards, commands.agentId);
}
