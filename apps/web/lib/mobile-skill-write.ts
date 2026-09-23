import { writeMobileSkill } from '@assistant/application/workspace-skills';
import {
  loadConfig,
  parseFirestoreEmbeddingSpace,
  validateAgentPersistenceConfig,
} from '@assistant/config';
import { createInstallationStore, FirestoreSkillMutationRepository } from '@assistant/firestore';
import type { OwnerSkillInput } from '@assistant/persistence';
import { embedFirestoreSkillText } from './server';

async function withFirestoreSkillMutation<T>(
  mutate: (repository: FirestoreSkillMutationRepository, agentId: string) => Promise<T>,
): Promise<T> {
  const config = loadConfig();
  const problems = validateAgentPersistenceConfig(config);
  if (problems.length) throw new Error(problems.join('; '));
  const store = createInstallationStore({
    projectId: config.GCP_PROJECT,
    installationId: config.ASSISTANT_WORKSPACE_ID,
    databaseId: config.FIRESTORE_DATABASE_ID,
  });
  try {
    return await mutate(new FirestoreSkillMutationRepository(store), config.FIRESTORE_AGENT_ID);
  } finally {
    await store.db.terminate();
  }
}

export async function writeFirestoreMobileSkill(
  input: OwnerSkillInput,
  skillId?: string,
): Promise<void> {
  const config = loadConfig();
  const problems = validateAgentPersistenceConfig(config);
  if (problems.length) throw new Error(problems.join('; '));
  const space = parseFirestoreEmbeddingSpace(config.FIRESTORE_EMBEDDING_SPACE);
  const store = createInstallationStore({
    projectId: config.GCP_PROJECT,
    installationId: config.ASSISTANT_WORKSPACE_ID,
    databaseId: config.FIRESTORE_DATABASE_ID,
  });
  try {
    const repository = new FirestoreSkillMutationRepository(store, space);
    await writeMobileSkill(
      repository,
      embedFirestoreSkillText,
      config.FIRESTORE_AGENT_ID,
      input,
      skillId,
    );
  } finally {
    await store.db.terminate();
  }
}

export function deleteFirestoreMobileSkill(skillId: string): Promise<void> {
  return withFirestoreSkillMutation((repository, agentId) => repository.delete(agentId, skillId));
}

export function setFirestoreMobileSkillDeprecated(
  skillId: string,
  deprecated: boolean,
): Promise<void> {
  return withFirestoreSkillMutation((repository, agentId) =>
    repository.setDeprecated(agentId, skillId, deprecated),
  );
}
