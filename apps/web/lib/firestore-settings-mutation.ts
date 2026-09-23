import { createSettingsFacade } from '@assistant/application/settings';
import { loadConfig, validateAgentPersistenceConfig } from '@assistant/config';
import {
  assertPrivacyErasureFenceUnchanged,
  createFirestoreSettingsPersistence,
  readPrivacyErasureFence,
} from '@assistant/firestore';
import { getFirestoreInstallationStore } from '@/lib/server';

/** Run a settings write against the configured Firestore owner only. */
export async function runFirestoreSettingsMutation<T>(
  operation: (settings: ReturnType<typeof createSettingsFacade>) => Promise<T>,
): Promise<T> {
  const config = loadConfig();
  const problems = validateAgentPersistenceConfig(config);
  if (problems.length) throw new Error(problems.join('; '));
  const store = getFirestoreInstallationStore();
  const assertConfiguredOwner = async () => {
    const agents = await store.collection('agents').limit(2).get();
    if (
      agents.size !== 1 ||
      agents.docs[0]?.id !== store.doc('agents', config.FIRESTORE_AGENT_ID).id ||
      agents.docs[0]?.get('id') !== config.FIRESTORE_AGENT_ID
    )
      throw new Error('Settings update requires exactly one configured agent');
  };

  await assertConfiguredOwner();
  const fence = await readPrivacyErasureFence(store, config.FIRESTORE_AGENT_ID);
  const settings = createSettingsFacade(
    createFirestoreSettingsPersistence(store, config.FIRESTORE_AGENT_ID),
  );
  const result = await operation(settings);
  await assertConfiguredOwner();
  await assertPrivacyErasureFenceUnchanged(store, config.FIRESTORE_AGENT_ID, fence);
  return result;
}
