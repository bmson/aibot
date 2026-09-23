import { loadConfig, validateAgentPersistenceConfig } from '@assistant/config';
import {
  assertPrivacyErasureFenceUnchanged,
  createFirestoreSettingsPersistence,
  readPrivacyErasureFence,
} from '@assistant/firestore';
import { getApplication, getFirestoreInstallationStore } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid reminder id' }, { status: 400 });
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
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
        throw new Error('Reminder deletion requires exactly one configured agent');
    };
    await assertConfiguredOwner();
    const fence = await readPrivacyErasureFence(store, config.FIRESTORE_AGENT_ID);
    const result = await createFirestoreSettingsPersistence(
      store,
      config.FIRESTORE_AGENT_ID,
    ).reminders.cancel(config.FIRESTORE_AGENT_ID, id);
    await assertConfiguredOwner();
    await assertPrivacyErasureFenceUnchanged(store, config.FIRESTORE_AGENT_ID, fence);
    if (!result.cancelled) return mobileJson({ error: 'reminder not found' }, { status: 404 });
  } else if (!(await getApplication().deleteReminder(id))) {
    return mobileJson({ error: 'reminder not found' }, { status: 404 });
  }
  return mobileJson({ ok: true });
}
