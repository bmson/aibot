import { getOwnerFactsView, type MemorySnapshot } from '@assistant/application/profile';
import { recompileCard } from '@/app/profile/actions';
import { AddFact } from '@/app/profile/add-fact';
import { FactRow, type FactView } from '@/app/profile/fact-row';
import { requireOwner } from '@/auth';
import { relativeTime } from '@/lib/format';
import { getDb } from '@/lib/server';
import {
  countBadgeClass,
  EmptyState,
  PageHeader,
  PageShell,
  Panel,
  SectionHeading,
  summaryClass,
} from '@/lib/ui';
import { SubmitButton } from '@/lib/ui-client';

export const metadata = { title: 'About you' };
export const dynamic = 'force-dynamic';

const DOMAIN_ORDER = [
  'identity',
  'work',
  'home',
  'relationships',
  'preferences',
  'health',
  'other',
] as const;

function toFactView(m: MemorySnapshot, now: Date, inCard: boolean): FactView {
  const from = m.validFrom?.toISOString().slice(0, 10);
  const until = m.validUntil?.toISOString().slice(0, 10);
  return {
    id: m.id,
    content: m.content,
    kind: m.kind,
    domain: m.domain ?? '',
    confidence: Number(m.confidence),
    importance: m.importance,
    ownerConfirmed: m.ownerConfirmed,
    pinned: m.pinned,
    organized: m.lastConsolidatedAt !== null,
    inCard,
    aboutOwner: true,
    originTrust: m.originTrust,
    sourceTaskId: m.sourceTaskId,
    createdLabel: relativeTime(m.createdAt, now),
    validityLabel: from ? `${from}–${until ?? 'now'}` : '',
  };
}

export default async function AboutYouPage() {
  await requireOwner();
  const db = getDb();
  const now = new Date();
  const { owner, ownerFacts, card, cardFactIds } = await getOwnerFactsView(db);
  const inCard = new Set(cardFactIds);
  const byDomain = DOMAIN_ORDER.map((domain) => ({
    domain,
    facts: ownerFacts.filter((m) => (m.domain ?? 'other') === domain),
  })).filter((group) => group.facts.length > 0);
  const pinnedCount = ownerFacts.filter((m) => m.pinned).length;

  return (
    <PageShell size="reading">
      <PageHeader
        back={{ href: '/profile', label: 'Memory' }}
        title={`About ${owner?.name ?? 'you'}`}
        intro="Everything the assistant has learned about you, and the compact summary it carries into every conversation."
      />

      {/* The compiled card first: it is what the assistant actually sees. */}
      <Panel className="mt-6">
        <details open>
          <summary className={summaryClass}>
            Used in conversations
            <span className={countBadgeClass}>{pinnedCount} pinned</span>
            <span className="text-xs font-normal text-muted">
              {card ? `refreshed ${relativeTime(card.compiledAt, now)}` : 'not prepared yet'}
            </span>
          </summary>
          {card?.content ? (
            <div className="mt-4 max-h-52 overscroll-contain overflow-y-auto rounded-xl bg-sunken/60 p-4 text-sm leading-6 whitespace-pre-wrap text-strong">
              {card.content}
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted">
              Nothing is selected yet. Pin a fact below or refresh this summary after adding one.
            </p>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <form action={recompileCard}>
              <SubmitButton variant="outline" pendingLabel="Refreshing…">
                Refresh summary
              </SubmitButton>
            </form>
            <span className="text-xs text-muted">
              This compact context is what the assistant sees before it searches deeper memory.
            </span>
          </div>
        </details>
      </Panel>

      <section className="mt-8">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <SectionHeading title="Your facts" count={ownerFacts.length} />
          {owner ? <AddFact subjectContactId={owner.id} subjectLabel="you" /> : null}
        </div>
        {byDomain.length === 0 ? (
          <EmptyState>
            No details yet — they are added from conversations only after review.
          </EmptyState>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            {byDomain.map((group) => {
              const pinnedInDomain = group.facts.filter((m) => m.pinned).length;
              return (
                <details key={group.domain} className="rounded-xl bg-sunken/55 p-3.5">
                  <summary className={summaryClass}>
                    <span className="font-mono text-xs font-medium tracking-[0.08em] text-muted uppercase">
                      {group.domain}
                    </span>
                    <span className={countBadgeClass}>{group.facts.length}</span>
                    {pinnedInDomain > 0 ? (
                      <span className="text-xs font-medium text-accent">
                        {pinnedInDomain} pinned
                      </span>
                    ) : null}
                  </summary>
                  <div className="mt-3 flex flex-col gap-2">
                    {group.facts.map((m) => (
                      <FactRow key={m.id} fact={toFactView(m, now, inCard.has(m.id))} />
                    ))}
                  </div>
                </details>
              );
            })}
          </div>
        )}
      </section>
    </PageShell>
  );
}
