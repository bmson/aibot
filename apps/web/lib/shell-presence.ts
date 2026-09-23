import { getShellPresence as projectShellPresence } from '@assistant/application';
import { loadConfig, validateAgentPersistenceConfig } from '@assistant/config';
import { createInstallationStore, FirestoreShellPresenceRepository } from '@assistant/firestore';
import { getDb } from './server';

const runtime = globalThis as typeof globalThis & {
  __assistantFirestoreShellPresence?: FirestoreShellPresenceRepository;
};

function getFirestoreRepository(config: ReturnType<typeof loadConfig>) {
  const problems = validateAgentPersistenceConfig(config);
  if (problems.length) throw new Error(problems.join('; '));
  runtime.__assistantFirestoreShellPresence ??= new FirestoreShellPresenceRepository(
    createInstallationStore({
      projectId: config.GCP_PROJECT,
      installationId: config.ASSISTANT_WORKSPACE_ID,
      databaseId: config.FIRESTORE_DATABASE_ID,
    }),
    config.FIRESTORE_AGENT_ID,
  );
  return runtime.__assistantFirestoreShellPresence;
}

/** Live shell polling uses a narrow presence read, separate from memory health. */
export function getWebShellPresence(agentId: string) {
  const config = loadConfig();
  return config.PERSISTENCE_DRIVER === 'firestore'
    ? projectShellPresence(getFirestoreRepository(config), agentId)
    : projectShellPresence(getDb(), agentId);
}
