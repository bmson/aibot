import { recompileProfileCard } from '@assistant/application/profile';
import { loadConfig, validateAgentPersistenceConfig } from '@assistant/config';
import {
  FirestoreOwnerCardCompilationRepository,
  FirestoreProfileOccasionCommandRepository,
  FirestoreProfilePeopleCommandRepository,
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
  };
}

export function recompileFirestoreProfileCard(
  commands: ReturnType<typeof getFirestoreProfileCommands>,
) {
  return recompileProfileCard(commands.ownerCards, commands.agentId);
}
