import { getKnowledgeGraphOverview, type KnowledgeGraphRelationView } from '@assistant/application';
import { ArrowRightLeft, Check, CircleAlert, GitFork, Network, Search, X } from 'lucide-react';
import Link from 'next/link';
import {
  confirmKnowledgeRelation,
  mergeKnowledgeEntity,
  rejectKnowledgeRelation,
  renameKnowledgeEntity,
  retryQuarantinedKnowledgeSources,
} from '@/app/profile/knowledge/actions';
import { AddKnowledgeRelation } from '@/app/profile/knowledge/add-relation';
import { requireOwner } from '@/auth';
import { relativeTime } from '@/lib/format';
import { getDb } from '@/lib/server';
import {
  Badge,
  btnSm,
  Card,
  cardFooterClass,
  cardShellClass,
  cardTitleClass,
  EmptyState,
  inputClass,
  labelClass,
  PageHeader,
  PageShell,
  selectClass,
} from '@/lib/ui';
import { ConfirmButton, SubmitButton } from '@/lib/ui-client';

export const metadata = { title: 'Knowledge review' };
export const dynamic = 'force-dynamic';

function hrefFor(query: string, entityId?: string): string {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (entityId) params.set('entity', entityId);
  const search = params.toString();
  return search ? `/profile/knowledge?${search}` : '/profile/knowledge';
}

function readablePredicate(predicate: string): string {
  return predicate.replaceAll('_', ' ');
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
      <span className="font-mono text-xs tracking-[0.06em] text-muted">
        {readablePredicate(relation.predicate)}
      </span>
      <span aria-hidden="true" className="text-muted">
        →
      </span>
      <span className="font-semibold text-strong">{relation.object.label}</span>
    </p>
  );
}

function ReviewRelation({ relation, now }: { relation: KnowledgeGraphRelationView; now: Date }) {
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
          <p className="font-mono text-[0.68rem] font-medium tracking-[0.08em] text-muted uppercase">
            Source memory
          </p>
          <p className="mt-1 whitespace-pre-wrap">{relation.source.content}</p>
        </div>
        <p className="text-xs leading-5 text-muted">
          {Math.round(relation.confidence * 100)}% extraction confidence · saved{' '}
          {relativeTime(relation.source.createdAt, now)} ·{' '}
          {relation.source.ownerConfirmed
            ? 'owner verified source'
            : `${relation.source.originTrust} source`}
          {relation.reviewedAt ? ` · reviewed ${relativeTime(relation.reviewedAt, now)}` : ''}
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
  searchParams: Promise<{ q?: string; entity?: string }>;
}) {
  await requireOwner();
  const params = await searchParams;
  const query = (params.q ?? '').trim().slice(0, 120);
  const graph = await getKnowledgeGraphOverview(getDb(), { query, entityId: params.entity });
  const now = new Date();
  const localEdges = graph.relations
    .filter((relation) => relation.reviewStatus !== 'rejected')
    .slice(0, 12);

  return (
    <PageShell size="wide">
      <PageHeader
        back={{ href: '/profile', label: 'Memory' }}
        title="Knowledge review"
        intro="Inspect the source-backed connections the assistant can use, validate their wording, and add corrections with your own evidence."
      />

      <div className="mt-6 grid gap-3 sm:grid-cols-4">
        <Card>
          <p className="font-mono text-xs font-medium tracking-[0.08em] text-muted uppercase">
            Entities
          </p>
          <p className="mt-2 font-display text-3xl font-semibold tracking-[-0.04em]">
            {graph.totalEntities.toLocaleString()}
          </p>
        </Card>
        <Card>
          <p className="font-mono text-xs font-medium tracking-[0.08em] text-muted uppercase">
            Connections
          </p>
          <p className="mt-2 font-display text-3xl font-semibold tracking-[-0.04em]">
            {graph.totalRelations.toLocaleString()}
          </p>
        </Card>
        <Card>
          <p className="font-mono text-xs font-medium tracking-[0.08em] text-muted uppercase">
            Needs review
          </p>
          <p className="mt-2 font-display text-3xl font-semibold tracking-[-0.04em] text-amber-700 dark:text-amber-300">
            {graph.unreviewedRelations.toLocaleString()}
          </p>
        </Card>
        <Card>
          <p className="font-mono text-xs font-medium tracking-[0.08em] text-muted uppercase">
            Graph sync
          </p>
          <p className="mt-2 font-display text-3xl font-semibold tracking-[-0.04em]">
            {graph.pendingSources.toLocaleString()}
          </p>
          <p className="mt-1 text-xs text-muted">
            waiting · {graph.quarantinedSources.toLocaleString()} paused
          </p>
          {graph.quarantinedSources > 0 ? (
            <form action={retryQuarantinedKnowledgeSources} className="mt-3">
              <SubmitButton size="sm" pendingLabel="Queueing…">
                Retry paused sources
              </SubmitButton>
            </form>
          ) : null}
        </Card>
      </div>

      <div className="mt-6 grid min-w-0 gap-6 lg:grid-cols-[minmax(14rem,0.7fr)_minmax(0,1.8fr)]">
        <aside className="min-w-0 lg:sticky lg:top-5 lg:self-start">
          <form action="/profile/knowledge" method="get" className="relative">
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
          </form>
          <nav
            className="mt-3 max-h-[calc(100dvh-13rem)] space-y-1 overflow-y-auto rounded-xl bg-sunken/40 p-1.5"
            aria-label="Knowledge items"
          >
            {graph.entities.length === 0 ? (
              <p className="px-3 py-6 text-sm text-muted">
                {query ? 'No matching knowledge items.' : 'No source-backed connections yet.'}
              </p>
            ) : (
              graph.entities.map((entity) => (
                <Link
                  key={entity.id}
                  href={hrefFor(query, entity.id)}
                  aria-current={entity.id === graph.selected?.id ? 'page' : undefined}
                  className={`block rounded-lg px-3 py-2.5 motion-safe:transition-colors ${
                    entity.id === graph.selected?.id
                      ? 'bg-raised text-strong ring-1 ring-edge/80'
                      : 'text-muted hover:bg-raised/70 hover:text-strong'
                  }`}
                >
                  <span className="block truncate text-sm font-medium">{entity.label}</span>
                  <span className="mt-0.5 block font-mono text-[0.68rem] tracking-[0.08em] uppercase opacity-70">
                    {entity.kind}
                  </span>
                </Link>
              ))
            )}
          </nav>
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
                    <p className="font-mono text-xs font-medium tracking-[0.08em] text-muted uppercase">
                      {graph.selected.kind}
                    </p>
                    <h2 className="mt-1 truncate font-display text-2xl font-semibold tracking-[-0.025em]">
                      {graph.selected.label}
                    </h2>
                    <p className="mt-1 text-sm text-muted">
                      {graph.relations.length} source-backed connection
                      {graph.relations.length === 1 ? '' : 's'}
                    </p>
                  </div>
                  <AddKnowledgeRelation selected={graph.selected} />
                </div>

                <div className="mt-5 grid gap-3 border-t border-edge pt-4 sm:grid-cols-2">
                  <form
                    action={renameKnowledgeEntity.bind(null, graph.selected.id)}
                    className="grid gap-2"
                  >
                    <label className={`grid gap-1 ${labelClass}`}>
                      Display name
                      <input
                        name="label"
                        required
                        minLength={1}
                        maxLength={160}
                        defaultValue={graph.selected.label}
                        className={inputClass}
                      />
                    </label>
                    <div>
                      <SubmitButton size="sm" pendingLabel="Saving…">
                        Rename display
                      </SubmitButton>
                    </div>
                  </form>
                  <form
                    action={mergeKnowledgeEntity.bind(null, graph.selected.id)}
                    className="grid gap-2"
                  >
                    <label className={`grid gap-1 ${labelClass}`}>
                      Merge this into
                      <select name="targetId" required defaultValue="" className={selectClass}>
                        <option value="" disabled>
                          Choose a matching item…
                        </option>
                        {graph.mergeOptions.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.label} ({option.kind})
                          </option>
                        ))}
                      </select>
                    </label>
                    <div>
                      <ConfirmButton
                        size="sm"
                        pendingLabel="Merging…"
                        confirmLabel="Merge items?"
                        title="Preserves all sources and routes future extractions to the remaining item."
                      >
                        <ArrowRightLeft className="size-3.5" aria-hidden="true" />
                        Merge entity
                      </ConfirmButton>
                    </div>
                  </form>
                </div>
              </section>

              <section className="mt-6">
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <div>
                    <h2 className={cardTitleClass}>Local map</h2>
                    <p className="mt-1 text-sm text-muted">
                      A focused view keeps the graph readable. Only non-stale, directly sourced
                      edges appear here.
                    </p>
                  </div>
                  <span className="inline-flex items-center gap-1 text-xs text-muted">
                    <GitFork className="size-3.5" aria-hidden="true" />
                    {localEdges.length} visible edge{localEdges.length === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="mt-3 overflow-hidden rounded-xl border border-edge bg-[radial-gradient(circle_at_center,rgba(81,143,106,0.12),transparent_48%)] p-4 sm:p-6">
                  <div className="mx-auto flex max-w-xs justify-center">
                    <div className="rounded-full border border-accent/30 bg-accent/10 px-5 py-3 text-center ring-4 ring-accent/5">
                      <p className="font-mono text-[0.65rem] font-medium tracking-[0.09em] text-accent uppercase">
                        {graph.selected.kind}
                      </p>
                      <p className="mt-0.5 text-sm font-semibold text-strong">
                        {graph.selected.label}
                      </p>
                    </div>
                  </div>
                  {localEdges.length === 0 ? (
                    <p className="mt-5 text-center text-sm text-muted">
                      No active connections to draw yet.
                    </p>
                  ) : (
                    <div className="mx-auto mt-5 grid max-w-3xl gap-2 sm:grid-cols-2">
                      {localEdges.map((relation) => {
                        const outbound = relation.subject.id === graph.selected?.id;
                        const other = outbound ? relation.object : relation.subject;
                        return (
                          <div
                            key={relation.id}
                            className="rounded-lg border border-edge/70 bg-raised/80 px-3 py-2.5"
                          >
                            <p className="text-xs text-muted">
                              {outbound ? 'outgoing' : 'incoming'} ·{' '}
                              {readablePredicate(relation.predicate)}
                            </p>
                            <p className="mt-1 flex items-center gap-1.5 text-sm font-medium text-strong">
                              <span aria-hidden="true" className="text-accent">
                                {outbound ? '→' : '←'}
                              </span>
                              <span className="truncate">{other.label}</span>
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  )}
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
                      <ReviewRelation key={relation.id} relation={relation} now={now} />
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
