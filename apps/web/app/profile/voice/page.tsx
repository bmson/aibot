import { getVoiceOverview } from '@assistant/application/profile';
import { type VoiceImportView, VoiceSamplesPanel } from '@/app/profile/voice-samples';
import { requireOwner } from '@/auth';
import { getDb } from '@/lib/server';
import { PageHeader, PageShell } from '@/lib/ui';

export const metadata = { title: 'Writing voice' };
export const dynamic = 'force-dynamic';

export default async function VoicePage() {
  await requireOwner();
  const db = getDb();
  const { voiceStats, voiceImports, voiceProfile } = await getVoiceOverview(db);
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
        back={{ href: '/profile', label: 'Memory' }}
        title="Your writing voice"
        intro="The voice the assistant imitates when it drafts on your behalf, and the sent messages it learned that voice from."
      />
      <VoiceSamplesPanel
        total={voiceStats.total}
        auto={voiceStats.auto}
        uploaded={voiceStats.uploaded}
        imports={importViews}
        profile={voiceProfile}
      />
    </PageShell>
  );
}
