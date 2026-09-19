import { listSavedCards } from '@assistant/application/cards';
import { Layers3 } from 'lucide-react';
import Link from 'next/link';
import { requireOwner } from '@/auth';
import { getAgentIdentity, getAgentTimezone, getGeneratedCards } from '@/lib/server';
import { btnSm, EmptyState, PageHeader, PageShell } from '@/lib/ui';
import { SavedCardGrid } from './saved-card-grid';

export const metadata = { title: 'Cards' };
export const dynamic = 'force-dynamic';

export default async function CardsPage() {
  await requireOwner();
  const [agent, timeZone] = await Promise.all([getAgentIdentity(), getAgentTimezone()]);
  const cards = agent.id ? await listSavedCards(getGeneratedCards(), agent.id) : [];

  return (
    <PageShell size="reading">
      <PageHeader
        back={{ href: '/chat', label: 'Chat' }}
        title="Cards"
        intro="Tickets, travel, scores, and other useful things the assistant has shaped from your information."
      />
      <Link href="/packs" className={`${btnSm.outline} mt-4`}>
        Situation packs · plans & follow-through
      </Link>
      {cards.length === 0 ? (
        <EmptyState
          icon={<Layers3 className="size-5" />}
          action={
            <Link href="/chat" className={btnSm.outline}>
              Ask about something
            </Link>
          }
        >
          No active cards. Ask about a booking, event, delivery, or score—or let the assistant
          notice one from connected mail.
        </EmptyState>
      ) : (
        <SavedCardGrid
          timeZone={timeZone}
          cards={cards.map((card) => ({
            kind: 'generated-card',
            id: card.id,
            revisionId: card.revisionId,
            spec: card.spec,
            updatedAt: card.updatedAt.toISOString(),
            stale: card.stale,
            refreshState: card.refreshState,
            refreshTaskId: card.refreshTaskId,
            refreshError: card.refreshError,
          }))}
        />
      )}
    </PageShell>
  );
}
