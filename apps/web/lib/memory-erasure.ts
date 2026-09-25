import { forgetLongTermMemoryWithRepository } from '@assistant/application/profile';
import { loadConfig, validateAgentPersistenceConfig } from '@assistant/config';
import { FirestorePrivacyErasureRepository } from '@assistant/firestore';
import { getApplication, getFirestoreInstallationStore, getWorkspace } from '@/lib/server';

/**
 * Irreversibly erase the owner's long-term recall and voice data with the
 * configured driver. Web and mobile share this so neither can skip a check.
 */
export async function forgetOwnerLongTermMemory(): Promise<void> {
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER !== 'firestore') {
    await getApplication().forgetLongTermMemory();
    return;
  }
  const problems = validateAgentPersistenceConfig(config);
  if (config.FILES_DRIVER === 'gcs' && !config.WORKSPACE_BUCKET.trim())
    problems.push('WORKSPACE_BUCKET is required for Firestore memory erasure');
  if (problems.length) throw new Error(problems.join('; '));
  await forgetLongTermMemoryWithRepository(
    new FirestorePrivacyErasureRepository(
      getFirestoreInstallationStore(),
      config.FIRESTORE_AGENT_ID,
    ),
    getWorkspace(),
  );
}
