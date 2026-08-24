import { getProfileOverview, type MemorySnapshot } from '@assistant/application/profile';
import { ArrowRight, CheckCircle2, Library, Network, ShieldQuestion } from 'lucide-react';
import Link from 'next/link';
import { AutoRefresh } from '@/app/auto-refresh';
import { recompileCard } from '@/app/profile/actions';
import { AddFact } from '@/app/profile/add-fact';
import { AddPerson } from '@/app/profile/add-person';
import { FactRow, type FactView } from '@/app/profile/fact-row';
import { MemoryOrganizer } from '@/app/profile/memory-organizer';
import { type VoiceImportView, VoiceSamplesPanel } from '@/app/profile/voice-samples';
import { requireOwner } from '@/auth';
import { relativeTime } from '@/lib/format';
import { getDb } from '@/lib/server';
import {
  Badge,
  btn,
  CountBadge,
  cardInteractiveClass,
  cardShellClass,
  cardTitleClass,
  countBadgeClass,
  EmptyState,
  PageHeader,
  PageShell,
  Panel,
  summaryClass,
} from '@/lib/ui';
import { SubmitButton } from '@/lib/ui-client';

export const metadata = { title: 'Memory' };

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

const countBadge = countBadgeClass;
function toFactView(m: MemorySnapshot, now: Date, inCard = false, aboutOwner = false): FactView {
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
    aboutOwner,
    originTrust: m.originTrust,
    sourceTaskId: m.sourceTaskId,
    createdLabel: relativeTime(m.createdAt, now),
    validityLabel: from ? `${from}–${until ?? 'now'}` : '',
  };
}

export default async function ProfilePage() {
  await requireOwner();
  const db = getDb();
  const now = new Date();
  const {
    owner,
    people,
    ownerFacts,
    quarantined,
    voiceStats,
    voiceImports,
    memoryHealth,
    latestOrganizer,
    card,
    cardFactIds: selectedCardFactIds,
  } = await getProfileOverview(db);
  const voiceImportViews: VoiceImportView[] = voiceImports.map((row) => ({
    source: row.source,
    status: row.status,
    itemsTotal: row.itemsTotal,
    itemsProcessed: row.itemsProcessed,
    memoriesSaved: row.memoriesSaved,
    taskId: row.taskId,
    error: row.error,
  }));

  const ownerByDomain = DOMAIN_ORDER.map((domain) => ({
    domain,
    facts: ownerFacts.filter((m) => (m.domain ?? 'other') === domain),
  })).filter((g) => g.facts.length > 0);

  const cardFactIds = new Set(selectedCardFactIds);

  const pinnedCount = ownerFacts.filter((m) => m.pinned).length;

  // Memory state only changes nightly or from an action on this page (which
  // revalidates on its own). The one thing that updates in the background is a
  // running consolidation pass — so poll only while one is active, instead of
  // re-running every query on this page every 8 seconds.
  const organizerActive =
    latestOrganizer?.status === 'pending' || latestOrganizer?.status === 'running';

  return (
    <PageShell size="reading">
      {organizerActive ? <AutoRefresh intervalMs={5_000} /> : null}
      <PageHeader
        back={{ href: '/chat', label: 'Chat' }}
        title="What I remember"
        intro={`See what shapes the assistant’s understanding of ${owner?.name ?? 'you'}, what still needs care, and what stays available for recall.`}
      />

      <section className="mt-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-[-0.025em]">Your memory library</h2>
            <p className="mt-1 text-sm leading-5 text-muted">
              Everything the assistant has learned, with controls to verify, correct, feature, or
              forget each fact.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link href="/profile/knowledge" className={btn.outline}>
              <Network className="size-3.5" aria-hidden="true" />
              Review knowledge graph
            </Link>
            <Link href="/profile/memories" className={`${btn.outline} group`}>
              Browse all
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </Link>
          </div>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Link
            href="/profile/memories"
            className={`${cardShellClass} ${cardInteractiveClass} group p-4 sm:p-5`}
          >
            <div className="flex items-start justify-between gap-4">
              <span className="inline-flex size-9 items-center justify-center rounded-xl bg-accent/10 text-accent">
                <Library className="size-4" aria-hidden="true" />
              </span>
              <span className="font-display text-3xl font-semibold tracking-[-0.04em]">
                {memoryHealth.totalUsable.toLocaleString()}
              </span>
            </div>
            <p className="mt-4 text-sm font-semibold">In use by the assistant</p>
            <p className="mt-1 text-xs leading-5 text-muted">
              Active facts that can be recalled in conversations
              {memoryHealth.ownerConfirmed > 0
                ? ` — ${memoryHealth.ownerConfirmed.toLocaleString()} verified by you`
                : ''}
              .
            </p>
            <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-accent">
              Browse and manage
              <ArrowRight className="size-3" aria-hidden="true" />
            </span>
          </Link>

          <Link
            href="/profile/memories?state=review"
            className={`${cardInteractiveClass} group rounded-2xl p-4 ring-1 sm:p-5 ${
              memoryHealth.awaitingReview > 0
                ? 'bg-amber-50/70 ring-amber-200 dark:bg-amber-950/20 dark:ring-amber-900'
                : 'bg-raised ring-edge/60'
            }`}
          >
            <div className="flex items-start justify-between gap-4">
              <span
                className={`inline-flex size-9 items-center justify-center rounded-xl ${
                  memoryHealth.awaitingReview > 0
                    ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
                    : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                }`}
              >
                {memoryHealth.awaitingReview > 0 ? (
                  <ShieldQuestion className="size-4" aria-hidden="true" />
                ) : (
                  <CheckCircle2 className="size-4" aria-hidden="true" />
                )}
              </span>
              <span className="font-display text-3xl font-semibold tracking-[-0.04em]">
                {memoryHealth.awaitingReview.toLocaleString()}
              </span>
            </div>
            <p className="mt-4 text-sm font-semibold">
              {memoryHealth.awaitingReview > 0 ? 'Waiting on you' : 'Nothing to review'}
            </p>
            <p className="mt-1 text-xs leading-5 text-muted">
              {memoryHealth.awaitingReview > 0
                ? 'Held back until you approve the source. Not used in conversations yet.'
                : 'Everything from unverified sources has been reviewed.'}
            </p>
            <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-accent">
              {memoryHealth.awaitingReview > 0 ? 'Review now' : 'View'}
              <ArrowRight className="size-3" aria-hidden="true" />
            </span>
          </Link>
        </div>
        <div className="mt-4">
          <MemoryOrganizer
            remaining={memoryHealth.notYetOrganized}
            latest={
              latestOrganizer
                ? {
                    id: latestOrganizer.id,
                    status: latestOrganizer.status,
                    progress: latestOrganizer.progress,
                    updatedLabel: relativeTime(latestOrganizer.updatedAt, now),
                  }
                : null
            }
          />
        </div>
      </section>

      {/* Quarantine review — the inbox; the only section that needs attention */}
      {quarantined.length > 0 ? (
        <section className="mt-6 rounded-2xl border border-amber-200 bg-amber-50/65 p-5 dark:border-amber-900 dark:bg-amber-950/20">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <ShieldQuestion
              className="size-4 text-amber-700 dark:text-amber-300"
              aria-hidden="true"
            />
            Awaiting your review
            <CountBadge tone="amber">{quarantined.length}</CountBadge>
          </h2>
          <p className="mt-1 text-xs text-muted">
            These came from unverified sources. The assistant will not use them until you approve
            them.
          </p>
          <div className="mt-3 flex flex-col gap-2">
            {quarantined.map((m) => (
              <FactRow key={m.id} fact={toFactView(m, now)} quarantine />
            ))}
          </div>
        </section>
      ) : null}

      {/* The compiled chat context is useful for auditing, but secondary to the facts themselves. */}
      <Panel className="mt-6">
        <details open>
          <summary className={summaryClass}>
            Used in conversations
            <span className={countBadge}>{pinnedCount} pinned</span>
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

      {/* Owner facts by domain — collapsed archive, browse when needed */}
      <Panel className="mt-6">
        <details>
          <summary className={summaryClass}>
            About {owner?.name ?? 'you'}
            <span className={countBadge}>{ownerFacts.length} facts</span>
            <span className="text-xs font-normal text-muted">
              Open when you need to edit, add, or verify something.
            </span>
          </summary>
          {owner ? (
            <div className="mt-3">
              <AddFact subjectContactId={owner.id} subjectLabel="you" />
            </div>
          ) : null}
          {ownerByDomain.length === 0 ? (
            <EmptyState>
              No details yet — they are added from conversations only after review.
            </EmptyState>
          ) : (
            <div className="mt-3 flex flex-col gap-2">
              {ownerByDomain.map((group) => {
                const pinnedInDomain = group.facts.filter((m) => m.pinned).length;
                return (
                  <details key={group.domain} className="rounded-xl bg-sunken/55 p-3.5">
                    <summary className={summaryClass}>
                      <span className="font-mono text-xs font-medium tracking-[0.08em] text-muted uppercase">
                        {group.domain}
                      </span>
                      <span className={countBadge}>{group.facts.length}</span>
                      {pinnedInDomain > 0 ? (
                        <span className="text-xs font-medium text-accent">
                          {pinnedInDomain} pinned
                        </span>
                      ) : null}
                    </summary>
                    <div className="mt-3 flex flex-col gap-2">
                      {group.facts.map((m) => (
                        <FactRow
                          key={m.id}
                          fact={toFactView(m, now, cardFactIds.has(m.id), true)}
                        />
                      ))}
                    </div>
                  </details>
                );
              })}
            </div>
          )}
        </details>
      </Panel>

      {/* Writing voice — sample corpus + one-time batch upload */}
      <VoiceSamplesPanel
        total={voiceStats.total}
        auto={voiceStats.auto}
        uploaded={voiceStats.uploaded}
        imports={voiceImportViews}
      />

      {/* People — one collapsed card per person */}
      <section className="mt-8">
        {/* No icon — a decorative check next to "People" said nothing, and no
            other section heading on this page carries one. */}
        <h2 className="flex items-center gap-2 text-lg font-semibold tracking-[-0.025em]">
          People
          <span className={countBadge}>{people.length}</span>
        </h2>
        <p className="mt-1 text-xs text-muted">
          Open a person to review what the assistant knows about them.
        </p>
        <div className="mt-3">
          <AddPerson />
        </div>
        {people.length === 0 ? (
          <EmptyState>
            No people yet — new names in conversations become contacts automatically.
          </EmptyState>
        ) : (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {people.map(({ contact, factCount }) => (
              <Link
                key={contact.id}
                href={`/profile/people/${contact.id}`}
                className={`${cardShellClass} ${cardInteractiveClass} group grid grid-cols-[minmax(0,1fr)_auto] gap-3 p-4`}
              >
                <div className="min-w-0">
                  <h3 className={`truncate ${cardTitleClass}`}>{contact.name}</h3>
                  <p className="mt-0.5 truncate text-xs text-muted">
                    {contact.relationship || 'Relationship not set'}
                  </p>
                </div>
                <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-accent">
                  Manage
                  <ArrowRight className="size-3" aria-hidden="true" />
                </span>
                <div className="col-span-2 flex flex-wrap items-center gap-2 border-t border-edge/70 pt-3">
                  <span className={countBadge}>
                    {factCount} fact{factCount === 1 ? '' : 's'}
                  </span>
                  {contact.trust === 'unknown' ? (
                    <Badge
                      tone="amber"
                      size="xs"
                      title="The assistant doesn't know who this is yet, so content from them is treated as untrusted. Saving a relationship marks them as known."
                    >
                      Unverified
                    </Badge>
                  ) : (
                    <span className="text-xs font-medium text-muted">Known contact</span>
                  )}
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </PageShell>
  );
}
