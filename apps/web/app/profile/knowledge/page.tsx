import {
  asGraphEntityKind,
  getAssistantTimezone,
  getKnowledgeGraphNeighborhood,
  getKnowledgeGraphOverview,
  type KnowledgeGraphRelationView,
} from '@assistant/application';
import {
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  GitFork,
  Network,
  Search,
  X,
} from 'lucide-react';
import Link from 'next/link';
import {
  confirmKnowledgeRelation,
  reextractDatedSources,
  rejectKnowledgeRelation,
  retryQuarantinedKnowledgeSources,
} from '@/app/profile/knowledge/actions';
import { AddKnowledgeRelation } from '@/app/profile/knowledge/add-relation';
import { MergeEntity, RenameEntity } from '@/app/profile/knowledge/entity-forms';
import { LocalMap } from '@/app/profile/knowledge/local-map';
import { requireOwner } from '@/auth';
import { formatFriendlyDateTime, formatUsd, relativeTime } from '@/lib/format';
import { ENTITY_KINDS, entityKindLabel, humanizePredicate } from '@/lib/knowledge';
import { getDb } from '@/lib/server';
import {
  Badge,
  btn,
  btnSm,
  Card,
  cardFooterClass,
  cardShellClass,
  cardTitleClass,
  EmptyState,
  inputClass,
  labelClass,
  microLabelClass,
  PageHeader,
  PageShell,
  selectClass,
} from '@/lib/ui';
import { ConfirmButton, SubmitButton } from '@/lib/ui-client';

export const metadata = { title: 'Knowledge review' };
export const dynamic = 'force-dynamic';

function hrefFor(opts: { q?: string; kind?: string; entity?: string; page?: number }): string {
  const params = new URLSearchParams();
  if (opts.q) params.set('q', opts.q);
  if (opts.kind) params.set('kind', opts.kind);
  if (opts.entity) params.set('entity', opts.entity);
  if (opts.page && opts.page > 1) params.set('page', String(opts.page));
  const search = params.toString();
  return search ? `/profile/knowledge?${search}` : '/profile/knowledge';
}

/**
 * The sync runs twice an hour, so a backlog is more legible as elapsed time
 * than as a run count once it stops being a handful of runs.
 */
function drainLabel(runs: number): string {
  if (runs <= 1) return 'one sync run';
  const hours = runs / 2;
  if (hours < 1.5) return `${runs} sync runs`;
  if (hours < 48) return `${Math.round(hours)} hours`;
  return `${Math.round(hours / 24)} days`;
}

function relationTone(status: KnowledgeGraphRelationView['reviewStatus']) {
  if (status === 'confirmed') return { label: 'Confirmed', tone: 'green' as const };
  if (status === 'rejected') return { label: 'Marked stale', tone: 'red' as const };
  return { label: 'Needs review', tone: 'amber' as const };
}

function RelationPath({ relation }: { relation: KnowledgeGraphRelationView }) {
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm leading-6">
      <span className="font-semibold text-strong">{relation.subject.label}</span>
      <span className="text-xs text-muted">{humanizePredicate(relation.predicate)}</span>
      <span aria-hidden="true" className="text-muted">
        →
      </span>
      <span className="font-semibold text-strong">{relation.object.label}</span>
    </p>
  );
}

function ReviewRelation({
  relation,
  now,
  timeZone,
}: {
  relation: KnowledgeGraphRelationView;
  now: Date;
  timeZone: string;
}) {
  const status = relationTone(relation.reviewStatus);
  const sourceQuery = relation.source.content.slice(0, 120);
  return (
    <article className={cardShellClass}>
      <div className="grid gap-3 p-4 sm:p-5">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
          <RelationPath relation={relation} />
          <Badge tone={status.tone} size="xs">
            {status.label}
          </Badge>
        </div>
        <div className="rounded-lg bg-sunken/60 p-3 text-sm leading-6 text-strong">
          <p className={`${microLabelClass} text-muted`}>Source memory</p>
          <p className="mt-1 whitespace-pre-wrap">{relation.source.content}</p>
        </div>
        {/* Relative time answers "recent or not?" at a glance; the calendar date
            beside it answers "which one?". Relative alone used to read "612d
            ago", which answers neither. */}
        <p className="text-xs leading-5 text-muted">
          {Math.round(relation.confidence * 100)}% extraction confidence · saved{' '}
          {relativeTime(relation.source.createdAt, now)} ·{' '}
          {formatFriendlyDateTime(relation.source.createdAt, timeZone, now)} ·{' '}
          {relation.source.ownerConfirmed
            ? 'owner verified source'
            : `${relation.source.originTrust} source`}
          {relation.reviewedAt
            ? ` · reviewed ${relativeTime(relation.reviewedAt, now)} (${formatFriendlyDateTime(
                relation.reviewedAt,
                timeZone,
                now,
              )})`
            : ''}
        </p>
      </div>
      <footer className={cardFooterClass}>
        <Link
          href={`/profile/memories?q=${encodeURIComponent(sourceQuery)}`}
          className={btnSm.outline}
        >
          Open source
        </Link>
        {relation.reviewStatus !== 'confirmed' ? (
          <form action={confirmKnowledgeRelation.bind(null, relation.id)}>
            <SubmitButton size="sm" variant="success" pendingLabel="Confirming…">
              <Check className="size-3.5" aria-hidden="true" />
              Confirm
            </SubmitButton>
          </form>
        ) : null}
        {relation.reviewStatus !== 'rejected' ? (
          <form action={rejectKnowledgeRelation.bind(null, relation.id)}>
            <ConfirmButton
              size="sm"
              pendingLabel="Marking…"
              confirmLabel="Mark stale?"
              title="Keeps the source memory, but excludes this edge from graph recall."
            >
              <X className="size-3.5" aria-hidden="true" />
              Mark stale
            </ConfirmButton>
          </form>
        ) : null}
      </footer>
    </article>
  );
}

export default async function KnowledgeReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; kind?: string; entity?: string; page?: string }>;
}) {
  await requireOwner();
  const params = await searchParams;
  const query = (params.q ?? '').trim().slice(0, 120);
  const kind = asGraphEntityKind(params.kind) ?? '';
  const requestedPage = Number.parseInt(params.page ?? '1', 10);
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const db = getDb();
  const [graph, timeZone] = await Promise.all([
    getKnowledgeGraphOverview(db, { query, kind, entityId: params.entity, page }),
    getAssistantTimezone(db),
  ]);
  const now = new Date();
  // The map draws from its own query, not the review list: the list is capped
  // at 80 and ordered unreviewed-first for triage, which drew a skewed subset
  // for high-degree entities.
  const neighborhood = graph.selected
    ? await getKnowledgeGraphNeighborhood(db, { entityId: graph.selected.id })
    : { entity: null, edges: [], total: 0 };

  return (
    <PageShell size="wide">
      <PageHeader
        back={{ href: '/profile', label: 'Memory' }}
        title="Knowledge review"
        intro="Inspect the source-backed connections the assistant can use, validate their wording, and add corrections with your own evidence."
        actions={
          <Link href="/profile/knowledge/calendar" className={btn.outline}>
            <CalendarDays className="size-4" aria-hidden="true" />
            Date calendar
          </Link>
        }
      />

      <div className="mt-6 grid gap-3 sm:grid-cols-4">
        <Card>
          <p className={`${microLabelClass} text-muted`}>Entities</p>
          <p className="mt-2 font-display text-3xl font-semibold tracking-[-0.04em]">
            {graph.totalEntities.toLocaleString()}
          </p>
        </Card>
        <Card>
          <p className={`${microLabelClass} text-muted`}>Connections</p>
          <p className="mt-2 font-display text-3xl font-semibold tracking-[-0.04em]">
            {graph.totalRelations.toLocaleString()}
          </p>
        </Card>
        <Card>
          <p className={`${microLabelClass} text-muted`}>Needs review</p>
          <p className="mt-2 font-display text-3xl font-semibold tracking-[-0.04em] text-amber-700 dark:text-amber-300">
            {graph.unreviewedRelations.toLocaleString()}
          </p>
        </Card>
        <Card>
          <p className={`${microLabelClass} text-muted`}>Graph sync</p>
          <p className="mt-2 font-display text-3xl font-semibold tracking-[-0.04em]">
            {graph.pendingSources.toLocaleString()}
          </p>
          <p className="mt-1 text-xs text-muted">
            waiting · {graph.quarantinedSources.toLocaleString()} paused
          </p>
          {/* The backlog drains through a metered model call per source, so the
              count alone does not say what it will cost. Priced from recent
              actuals; omitted rather than guessed when history is too thin. */}
          {graph.pendingSources > 0 ? (
            <p className="mt-1 text-xs text-muted">
              {graph.pendingCostUsd === null
                ? `about ${graph.pendingRuns.toLocaleString()} sync run${
                    graph.pendingRuns === 1 ? '' : 's'
                  } to clear`
                : `~${formatUsd(String(graph.pendingCostUsd))} to clear, about ${drainLabel(
                    graph.pendingRuns,
                  )}`}
            </p>
          ) : null}
          {graph.quarantinedSources > 0 ? (
            <form action={retryQuarantinedKnowledgeSources} className="mt-3">
              <SubmitButton size="sm" pendingLabel="Queueing…">
                Retry paused sources
              </SubmitButton>
            </form>
          ) : null}
          {/* The nightly backfill already re-canonicalized every date it could
              read for free. What is left needs a model call each, so it is
              offered with its price rather than queued behind the owner's back. */}
          {graph.relativeDateSources > 0 ? (
            <form action={reextractDatedSources} className="mt-3">
              <p className="mb-1.5 text-xs leading-5 text-muted">
                {graph.relativeDateSources.toLocaleString()} source
                {graph.relativeDateSources === 1 ? '' : 's'} still date things relative to when they
                were written.
              </p>
              <SubmitButton size="sm" pendingLabel="Queueing…">
                Re-read their dates
              </SubmitButton>
            </form>
          ) : null}
        </Card>
      </div>

      <div className="mt-6 grid min-w-0 gap-6 lg:grid-cols-[minmax(14rem,0.7fr)_minmax(0,1.8fr)]">
        <aside className="min-w-0 lg:sticky lg:top-5 lg:self-start">
          <form action="/profile/knowledge" method="get" className="grid gap-2">
            <label className="relative block">
              <span className="sr-only">Search knowledge items</span>
              <Search
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
                aria-hidden="true"
              />
              <input
                type="search"
                name="q"
                defaultValue={query}
                placeholder="Find a person, project, place…"
                className={`${inputClass} w-full pl-9`}
              />
            </label>
            <div className="flex items-center gap-2">
              <label className="min-w-0 flex-1">
                <span className={`sr-only ${labelClass}`}>Type</span>
                <select name="kind" defaultValue={kind} className={`${selectClass} w-full`}>
                  <option value="">All types</option>
                  {ENTITY_KINDS.map((value) => (
                    <option key={value} value={value}>
                      {entityKindLabel(value)}
                    </option>
                  ))}
                </select>
              </label>
              {/* An explicit submit keeps the filter usable without client JS;
                  the form otherwise only applies on Enter. */}
              <button type="submit" className={btn.outline}>
                Apply
              </button>
            </div>
          </form>
          {/* The stat card above prints the true entity count, so this list has
              to say how much of it is on screen — the two silently disagreeing
              is what made the page feel like it was hiding things. */}
          <p className="mt-2 px-1 text-xs text-muted">
            {graph.matchingEntities.toLocaleString()}
            {query ? ' matching' : ''} item{graph.matchingEntities === 1 ? '' : 's'}
            {kind ? ` · ${entityKindLabel(kind)} only` : ''}
            {graph.entityPages > 1 ? ` · page ${graph.entityPage} of ${graph.entityPages}` : ''}
          </p>
          <nav
            className="mt-2 max-h-[calc(100dvh-16rem)] space-y-1 overflow-y-auto rounded-xl bg-sunken/40 p-1.5"
            aria-label="Knowledge items"
          >
            {graph.entities.length === 0 ? (
              <p className="px-3 py-6 text-sm text-muted">
                {query || kind
                  ? 'No matching knowledge items.'
                  : 'No source-backed connections yet.'}
              </p>
            ) : (
              graph.entities.map((entity) => (
                <Link
                  key={entity.id}
                  href={hrefFor({ q: query, kind, entity: entity.id, page: graph.entityPage })}
                  aria-current={entity.id === graph.selected?.id ? 'page' : undefined}
                  title={entity.label}
                  className={`block rounded-lg px-3 py-2.5 motion-safe:transition-colors ${
                    entity.id === graph.selected?.id
                      ? 'bg-raised text-strong ring-1 ring-edge/80'
                      : 'text-muted hover:bg-raised/70 hover:text-strong'
                  }`}
                >
                  <span className="block truncate text-sm font-medium">{entity.label}</span>
                  <span className="mt-0.5 block text-[0.68rem] opacity-70">
                    {entityKindLabel(entity.kind)}
                  </span>
                </Link>
              ))
            )}
          </nav>
          {graph.entityPages > 1 ? (
            <nav className="mt-3 flex items-center justify-between gap-2" aria-label="Item pages">
              {graph.entityPage > 1 ? (
                <Link
                  href={hrefFor({ q: query, kind, page: graph.entityPage - 1 })}
                  className={btn.outline}
                >
                  <ChevronLeft className="size-4" aria-hidden="true" />
                  Previous
                </Link>
              ) : (
                <span />
              )}
              {graph.entityPage < graph.entityPages ? (
                <Link
                  href={hrefFor({ q: query, kind, page: graph.entityPage + 1 })}
                  className={btn.outline}
                >
                  Next
                  <ChevronRight className="size-4" aria-hidden="true" />
                </Link>
              ) : null}
            </nav>
          ) : null}
        </aside>

        <main className="min-w-0">
          {!graph.selected ? (
            <EmptyState>
              <Network className="mx-auto size-5 text-muted" aria-hidden="true" />
              <p className="mt-2 font-medium text-strong">
                Your graph will appear as memories connect
              </p>
              <p className="mt-1 text-sm text-muted">
                Add a relationship below, or wait for the knowledge-graph sync to process durable
                facts.
              </p>
              <AddKnowledgeRelation selected={null} />
            </EmptyState>
          ) : (
            <>
              <section className={`${cardShellClass} p-4 sm:p-5`}>
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className={`${microLabelClass} text-muted`}>
                      {entityKindLabel(graph.selected.kind)}
                    </p>
                    <h2
                      className="mt-1 truncate font-display text-2xl font-semibold tracking-[-0.025em]"
                      title={graph.selected.label}
                    >
                      {graph.selected.label}
                    </h2>
                    <p className="mt-1 text-sm text-muted">
                      {graph.selectedRelationTotal.toLocaleString()} source-backed connection
                      {graph.selectedRelationTotal === 1 ? '' : 's'}
                      {graph.relations.length < graph.selectedRelationTotal
                        ? ` · showing the first ${graph.relations.length}`
                        : ''}
                    </p>
                  </div>
                  <AddKnowledgeRelation selected={graph.selected} />
                </div>

                <div className="mt-5 grid gap-4 border-t border-edge pt-4 sm:grid-cols-2">
                  <RenameEntity entity={graph.selected} />
                  <MergeEntity entity={graph.selected} duplicates={graph.duplicates} />
                </div>
              </section>

              <section className="mt-6">
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <div>
                    <h2 className={cardTitleClass}>Local map</h2>
                    <p className="mt-1 text-sm text-muted">
                      Drag to pan, scroll or use the buttons to zoom. Open a neighbour to re-centre
                      on it, or press its + to grow its own connections in place.
                    </p>
                  </div>
                  <span className="inline-flex items-center gap-1 text-xs text-muted">
                    <GitFork className="size-3.5" aria-hidden="true" />
                    {neighborhood.total.toLocaleString()} active edge
                    {neighborhood.total === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="mt-3">
                  <LocalMap
                    selected={graph.selected}
                    initialEdges={neighborhood.edges}
                    totalEdges={neighborhood.total}
                    query={query}
                    kind={kind}
                  />
                </div>
              </section>

              <section className="mt-6">
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <div>
                    <h2 className={cardTitleClass}>Connections and evidence</h2>
                    <p className="mt-1 text-sm text-muted">
                      Validate the extraction against its original memory. Marking an edge stale
                      keeps the source but removes it from GraphRAG.
                    </p>
                  </div>
                  {graph.unreviewedRelations > 0 ? (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-300">
                      <CircleAlert className="size-3.5" aria-hidden="true" />
                      {graph.unreviewedRelations} awaiting review
                    </span>
                  ) : null}
                </div>
                {graph.relations.length === 0 ? (
                  <EmptyState>
                    This item has no source-backed edges yet. Add one with a note if it should be
                    connected.
                  </EmptyState>
                ) : (
                  <div className="mt-3 grid gap-3">
                    {graph.relations.map((relation) => (
                      <ReviewRelation
                        key={relation.id}
                        relation={relation}
                        now={now}
                        timeZone={timeZone}
                      />
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </main>
      </div>
    </PageShell>
  );
}
