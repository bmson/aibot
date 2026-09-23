import { loadConfig } from '@assistant/config';
import { PrivacyControls } from '@/app/profile/privacy-controls';
import { requireOwner } from '@/auth';
import { PageHeader, PageShell } from '@/lib/ui';

export const metadata = { title: 'Your data' };
export const dynamic = 'force-dynamic';

export default async function DataPage() {
  await requireOwner();
  const firestore = loadConfig().PERSISTENCE_DRIVER === 'firestore';
  return (
    <PageShell size="reading">
      <PageHeader
        back={{ href: '/profile', label: 'Memory' }}
        title="Your data"
        intro={
          firestore
            ? 'Download the long-term memory the assistant uses for recall and writing voice.'
            : 'Export everything the assistant remembers, or forget it permanently.'
        }
      />
      <PrivacyControls readOnly={firestore} />
    </PageShell>
  );
}
