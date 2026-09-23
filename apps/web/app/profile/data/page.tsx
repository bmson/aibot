import { PrivacyControls } from '@/app/profile/privacy-controls';
import { requireOwner } from '@/auth';
import { PageHeader, PageShell } from '@/lib/ui';

export const metadata = { title: 'Your data' };
export const dynamic = 'force-dynamic';

export default async function DataPage() {
  await requireOwner();
  return (
    <PageShell size="reading">
      <PageHeader
        back={{ href: '/profile', label: 'Memory' }}
        title="Your data"
        intro="Export everything the assistant remembers, or forget it permanently."
      />
      <PrivacyControls />
    </PageShell>
  );
}
