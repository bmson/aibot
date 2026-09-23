import { recordOwnerForegroundWithRepository } from '@assistant/application';
import { loadConfig, validateAgentPersistenceConfig } from '@assistant/config';
import {
  assertPrivacyErasureFenceUnchanged,
  createFirestoreSettingsPersistence,
  readPrivacyErasureFence,
} from '@assistant/firestore';
import { getApplication, getFirestoreInstallationStore } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

/**
 * The iOS app reporting a foreground open — the wake-up signal that can fire
 * the morning brief early (once a day, deduped server-side).
 */
export async function POST(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) return mobileJson({ error: problems.join('; ') }, { status: 503 });
    const store = getFirestoreInstallationStore();
    const assertOwner = async () => {
      const agents = await store.collection('agents').limit(2).get();
      const owner = agents.docs[0];
      if (
        agents.size !== 1 ||
        !owner ||
        owner.id !== store.doc('agents', config.FIRESTORE_AGENT_ID).id ||
        owner.get('id') !== config.FIRESTORE_AGENT_ID
      )
        throw new Error('Foreground activity requires exactly one configured agent');
    };
    try {
      await assertOwner();
      const fence = await readPrivacyErasureFence(store, config.FIRESTORE_AGENT_ID);
      const persistence = createFirestoreSettingsPersistence(store, config.FIRESTORE_AGENT_ID);
      const owner = await persistence.settings.getOwner();
      if (!owner) throw new Error('Configured foreground activity owner is missing');
      const result = await recordOwnerForegroundWithRepository(persistence.schedules, owner);
      await assertOwner();
      await assertPrivacyErasureFenceUnchanged(store, config.FIRESTORE_AGENT_ID, fence);
      return mobileJson(result);
    } catch (error) {
      return mobileJson(
        { error: error instanceof Error ? error.message : 'Foreground activity failed.' },
        { status: 409 },
      );
    }
  }
  const result = await getApplication().recordOwnerForeground();
  return mobileJson(result);
}
