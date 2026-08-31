import { listSavedCards } from '@assistant/application/cards';
import { Archive, Layers3 } from 'lucide-react';
import Link from 'next/link';
import { ResponseCards } from '@/app/chat/[id]/response-card';
import { requireOwner } from '@/auth';
import { getAgentIdentity, getAgentTimezone, getDb } from '@/lib/server';
import { btnSm, EmptyState, PageHeader, PageShell } from '@/lib/ui';
import { dismissCard } from './actions';

export const metadata = { title: 'Cards' };
export const dynamic = 'force-dynamic';

export default async function CardsPage() {
  await requireOwner();
  const [agent, timeZone] = await Promise.all([getAgentIdentity(), getAgentTimezone()]);
  const cards = agent.id ? await listSavedCards(getDb(), agent.id) : [];

  return (
    <PageShell size="reading">
      <PageHeader
        back={{ href: '/chat', label: 'Chat' }}
        title="Cards"
        intro="Tickets, travel, scores, and other useful things the assistant has shaped from your information."
      />
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
        <div className="mt-8 grid gap-5">
          {cards.map((card) => (
            <article key={card.id} className="min-w-0">
              <ResponseCards
                timeZone={timeZone}
                cards={[
                  {
                    kind: 'generated-card',
                    id: card.id,
                    revisionId: card.revisionId,
                    spec: card.spec,
                  },
                ]}
              />
              <div className="mt-2 flex items-center justify-between gap-3 px-1">
                <p className="font-mono text-[10px] tracking-[0.08em] text-muted uppercase">
                  Saved{' '}
                  {card.updatedAt.toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    timeZone,
                  })}
                </p>
                <form action={dismissCard}>
                  <input type="hidden" name="cardId" value={card.id} />
                  <button type="submit" className={btnSm.outline}>
                    <Archive className="size-3" aria-hidden="true" />
                    Dismiss
                  </button>
                </form>
              </div>
            </article>
          ))}
        </div>
      )}
    </PageShell>
  );
}
