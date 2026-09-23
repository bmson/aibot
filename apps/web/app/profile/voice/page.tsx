import { getVoiceOverview } from '@assistant/application/profile';
import { loadConfig } from '@assistant/config';
import {
  assertPrivacyErasureFenceUnchanged,
  createInstallationStore,
  FirestoreProfileVoiceOverviewRepository,
  readPrivacyErasureFence,
} from '@assistant/firestore';
import { type VoiceImportView, VoiceSamplesPanel } from '@/app/profile/voice-samples';
import { requireOwner } from '@/auth';
import { getDb } from '@/lib/server';
import { PageHeader, PageShell } from '@/lib/ui';

export const metadata = { title: 'Writing voice' };
export const dynamic = 'force-dynamic';

async function getFirestoreVoiceOverview() {
  const config = loadConfig();
  const store = createInstallationStore({
    projectId: config.GCP_PROJECT,
    installationId: config.ASSISTANT_WORKSPACE_ID,
    databaseId: config.FIRESTORE_DATABASE_ID,
  });
  try {
    const assertConfiguredOwner = async () => {
      const agents = await store.collection('agents').limit(2).get();
      if (agents.size !== 1 || agents.docs[0]?.get('id') !== config.FIRESTORE_AGENT_ID)
        throw new Error('Voice overview requires one matching configured owner');
    };
    await assertConfiguredOwner();
    const fence = await readPrivacyErasureFence(store, config.FIRESTORE_AGENT_ID);
    const overview = await getVoiceOverview(
      new FirestoreProfileVoiceOverviewRepository(store, config.FIRESTORE_AGENT_ID),
    );
    await assertConfiguredOwner();
    await assertPrivacyErasureFenceUnchanged(store, config.FIRESTORE_AGENT_ID, fence);
    return overview;
  } finally {
    await store.db.terminate();
  }
}

export default async function VoicePage() {
  await requireOwner();
  const readOnly = loadConfig().PERSISTENCE_DRIVER === 'firestore';
  const { voiceStats, voiceImports, voiceProfile } = readOnly
    ? await getFirestoreVoiceOverview()
    : await getVoiceOverview(getDb());
  const importViews: VoiceImportView[] = voiceImports.map((row) => ({
    source: row.source,
    status: row.status,
    itemsTotal: row.itemsTotal,
    itemsProcessed: row.itemsProcessed,
    memoriesSaved: row.memoriesSaved,
    taskId: row.taskId,
    error: row.error,
  }));

  return (
    <PageShell size="reading">
      <PageHeader
        back={{ href: readOnly ? '/profile/memories' : '/profile', label: 'Memory' }}
        title="Your writing voice"
        intro="The voice the assistant imitates when it drafts on your behalf, and the sent messages it learned that voice from."
      />
      <VoiceSamplesPanel
        total={voiceStats.total}
        auto={voiceStats.auto}
        uploaded={voiceStats.uploaded}
        imports={importViews}
        profile={voiceProfile}
        readOnly={readOnly}
      />
    </PageShell>
  );
}
