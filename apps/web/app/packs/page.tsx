import { PageHeader, PageShell } from '@/lib/ui';
import { changePack, loadPacks } from './actions';
import { PacksPanel } from './packs-panel';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Situation packs' };

export default async function PacksPage() {
  const initial = await loadPacks();
  return (
    <PageShell size="reading">
      <PageHeader
        back={{ href: '/cards', label: 'Cards' }}
        title="Situation packs"
        intro="Keep the plan, the people you’re waiting on, and the reasons behind your choices together."
      />
      <PacksPanel initial={initial} change={changePack} reload={loadPacks} />
    </PageShell>
  );
}
