import {
  asGraphEntityKind,
  getAssistantLocale,
  getKnowledgeGraphMapSummary,
  getKnowledgeGraphOverview,
  getKnowledgeGraphReviewQueue,
  type KnowledgeGraphRelationView,
  PREDICATE_VOCABULARY,
  readableKnowledgeLabel,
} from '@assistant/application';
import { Check, CircleAlert, Network, Search, X } from 'lucide-react';
import Link from 'next/link';
import {
  confirmKnowledgeRelation,
  reextractDatedSources,
  rejectKnowledgeRelation,
} from '@/app/profile/knowledge/actions';
import { AddKnowledgeRelation } from '@/app/profile/knowledge/add-relation';
import { EditKnowledgeEntity } from '@/app/profile/knowledge/entity-forms';
import { LocalMap } from '@/app/profile/knowledge/local-map';
import { requireOwner } from '@/auth';
import { entityKindLabel, formatCanonicalDateKey } from '@/lib/knowledge';
import { getDb } from '@/lib/server';
import {
  Badge,
  btn,
  btnSm,
  cardShellClass,
  cardTitleClass,
  EmptyState,
  inputClass,
  microLabelClass,
  PageHeader,
  PageShell,
  selectClass,
} from '@/lib/ui';
import { ConfirmButton, SubmitButton } from '@/lib/ui-client';

export const metadata = { title: 'Knowledge' };
export const dynamic = 'force-dynamic';

type Mode = 'relationships' | 'review' | 'map';

function modeFor(params: { mode?: string; view?: string }): Mode {
  if (params.mode === 'review') return 'review';
  if (params.mode === 'map' || params.view === 'map') return 'map';
  // Existing Explorer, Paths, and Details links return to the one primary
  // relationship view instead of preserving four competing mental models.
  return 'relationships';
}

function hrefFor(input: {
  q?: string;
  kind?: string;
  entity?: string;
  page?: number;
  mode?: Mode;
  mapFamily?: string;
}): string {
  const params = new URLSearchParams();
  if (input.q) params.set('q', input.q);
  if (input.kind) params.set('kind', input.kind);
  if (input.entity) params.set('entity', input.entity);
  if (input.page && input.page > 1) params.set('page', String(input.page));
  if (input.mode && input.mode !== 'relationships') params.set('mode', input.mode);
  if (input.mapFamily) params.set('mapFamily', input.mapFamily);
  const search = params.toString();
  return search ? `/profile/knowledge?${search}` : '/profile/knowledge';
}

function familyFor(predicate: string): string {
  return PREDICATE_VOCABULARY.find((entry) => entry.id === predicate)?.group ?? 'other';
}

function familyLabel(family: string): string {
  return family === 'work and education'
    ? 'Work and education'
    : family.charAt(0).toLocaleUpperCase() + family.slice(1);
}

function relationTone(relation: KnowledgeGraphRelationView) {
  return relation.reviewStatus === 'confirmed'
    ? { tone: 'green' as const, label: 'Confirmed' }
    : relation.reviewStatus === 'rejected'
      ? { tone: 'red' as const, label: 'Marked inaccurate' }
      : { tone: 'amber' as const, label: 'Needs review' };
}

function RelationCard({
  relation,
  locale,
  query,
  kind,
  focusId,
}: {
  relation: KnowledgeGraphRelationView;
  locale: string;
  query: string;
  kind: string;
  /** The selected item, when this card is being shown from its relationship list. */
  focusId?: string;
}) {
  const tone = relationTone(relation);
  const other = relation.subject.id === focusId ? relation.object : relation.subject;
  return (
    <article className={`${cardShellClass} p-4 sm:p-5`}>
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={`${microLabelClass} text-muted`}>{relation.presentation.label}</p>
          <p className="mt-1 text-base font-semibold leading-6 text-strong">
            {relation.presentation.sentence}
          </p>
        </div>
        <span className="flex flex-wrap items-center gap-1.5">
          {!relation.inRecall ? (
            <Badge tone="muted" size="xs">
              Not in recall
            </Badge>
          ) : null}
          <Badge tone={tone.tone} size="xs">
            {tone.label}
          </Badge>
        </span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>{Math.round(relation.confidence * 100)}% confidence</span>
        {relation.validFrom || relation.validUntil ? (
          <span>
            {relation.validFrom
              ? formatCanonicalDateKey(relation.validFrom, locale)
              : 'Unknown start'}
            {' to '}
            {relation.validUntil ? formatCanonicalDateKey(relation.validUntil, locale) : 'now'}
          </span>
        ) : null}
      </div>
      <details className="mt-4 rounded-lg bg-sunken/50 p-3">
        <summary className="cursor-pointer text-sm font-medium text-strong">
          View source evidence
        </summary>
        <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-muted">
          {relation.source.content}
        </p>
      </details>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Link href={hrefFor({ q: query, kind, entity: other.id })} className={btnSm.outline}>
          Open {readableKnowledgeLabel(other.label)}
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
              pendingLabel="Saving…"
              confirmLabel="Mark inaccurate?"
              title="Keeps the source evidence but excludes this connection from graph recall."
            >
              <X className="size-3.5" aria-hidden="true" />
              Mark inaccurate
            </ConfirmButton>
          </form>
        ) : null}
        <AddKnowledgeRelation
          selected={relation.subject}
          vocabulary={PREDICATE_VOCABULARY}
          correction={relation}
        />
      </div>
    </article>
  );
}

function RelationshipList({
  relations,
  locale,
  query,
  kind,
  focusId,
}: {
  relations: KnowledgeGraphRelationView[];
  locale: string;
  query: string;
  kind: string;
  focusId?: string;
}) {
  const active = relations.filter((relation) => relation.reviewStatus !== 'rejected');
  const groups = new Map<string, KnowledgeGraphRelationView[]>();
  for (const relation of active) {
    const family = familyFor(relation.predicate);
    groups.set(family, [...(groups.get(family) ?? []), relation]);
  }
  if (active.length === 0) {
    return (
      <EmptyState>
        No active connections yet. Add one with a source note to make it useful.
      </EmptyState>
    );
  }
  return (
    <div className="grid gap-7">
      {[...groups.entries()].map(([family, items]) => (
        <section key={family}>
          <div className="mb-3 flex items-center gap-3">
            <h3 className={cardTitleClass}>{familyLabel(family)}</h3>
            <span className="text-xs text-muted">{items.length}</span>
          </div>
          <div className="grid gap-3">
            {items.map((relation) => (
              <RelationCard
                key={relation.id}
                relation={relation}
                locale={locale}
                query={query}
                kind={kind}
                focusId={focusId}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    kind?: string;
    entity?: string;
    page?: string;
    mode?: string;
    view?: string;
    mapFamily?: string;
  }>;
}) {
  await requireOwner();
  const params = await searchParams;
  const query = (params.q ?? '').trim().slice(0, 120);
  const kind = asGraphEntityKind(params.kind) ?? '';
  const requestedPage = Number.parseInt(params.page ?? '1', 10);
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const mode = modeFor(params);
  const db = getDb();
  const [graph, locale, review] = await Promise.all([
    getKnowledgeGraphOverview(db, { query, kind, entityId: params.entity, page }),
    getAssistantLocale(db),
    mode === 'review' ? getKnowledgeGraphReviewQueue(db) : Promise.resolve([]),
  ]);
  const selectedFamily = params.mapFamily ?? '';
  const familyPredicates = selectedFamily
    ? PREDICATE_VOCABULARY.filter((entry) => entry.group === selectedFamily).map(
        (entry) => entry.id,
      )
    : [];
  const map =
    mode === 'map' && graph.selected
      ? await getKnowledgeGraphMapSummary(db, {
          entityId: graph.selected.id,
          predicates: familyPredicates,
        })
      : null;
  const mapFamilies = map
    ? [...new Set(map.predicateCounts.map((row) => familyFor(row.predicate)))].map((family) => ({
        family,
        count: map.predicateCounts
          .filter((row) => familyFor(row.predicate) === family)
          .reduce((total, row) => total + row.count, 0),
      }))
    : [];

  return (
    <PageShell size="wide">
      <PageHeader
        back={{ href: '/profile', label: 'Memory' }}
        title="Knowledge"
        intro="Browse what your assistant knows, understand every connection, and keep its evidence accurate."
        actions={
          <Link
            href={hrefFor({ q: query, kind, entity: graph.selected?.id, mode: 'review' })}
            className={btn.outline}
          >
            <CircleAlert className="size-4" aria-hidden="true" />
            Review {graph.unreviewedRelations.toLocaleString()}
          </Link>
        }
      />

      <section className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-edge bg-sunken/35 px-4 py-3 text-sm">
        <span>
          <strong className="text-strong">{graph.totalEntities.toLocaleString()}</strong> items
        </span>
        <span>
          <strong className="text-strong">{graph.totalRelations.toLocaleString()}</strong>{' '}
          connections
        </span>
        <details className="text-muted">
          <summary className="cursor-pointer font-medium">Graph processing</summary>
          <p className="mt-2 max-w-xl text-xs leading-5">
            {graph.pendingSources.toLocaleString()} sources are waiting to be read.{' '}
            {graph.relativeDateSources > 0
              ? `${graph.relativeDateSources} date-related sources can be re-read if needed.`
              : 'All date wording is current.'}
          </p>
          {graph.relativeDateSources > 0 ? (
            <form action={reextractDatedSources} className="mt-2">
              <SubmitButton size="sm" pendingLabel="Queueing…">
                Re-read dates
              </SubmitButton>
            </form>
          ) : null}
        </details>
      </section>

      {mode === 'review' ? (
        <section className="mt-7 max-w-3xl">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className={microLabelClass}>Review inbox</p>
              <h2 className="mt-1 font-display text-2xl font-semibold text-strong">
                Confirm what should stay connected
              </h2>
              <p className="mt-1 text-sm text-muted">
                Evidence stays folded away until you need it; every decision remains traceable.
              </p>
            </div>
            <Link
              href={hrefFor({ q: query, kind, entity: graph.selected?.id })}
              className={btnSm.outline}
            >
              Back to relationships
            </Link>
          </div>
          <div className="mt-5 grid gap-3">
            {review.length === 0 ? (
              <EmptyState>Nothing needs review right now.</EmptyState>
            ) : (
              review.map((relation) => (
                <RelationCard
                  key={relation.id}
                  relation={relation}
                  locale={locale}
                  query={query}
                  kind={kind}
                />
              ))
            )}
          </div>
        </section>
      ) : (
        <div className="mt-7 grid min-w-0 gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
          <aside className="order-2 min-w-0 lg:order-1 lg:sticky lg:top-5 lg:self-start">
            <form
              action="/profile/knowledge"
              method="get"
              className="grid gap-2 rounded-xl bg-sunken/35 p-3"
            >
              <label className="relative block">
                <span className="sr-only">Find a knowledge item</span>
                <Search
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
                  aria-hidden="true"
                />
                <input
                  name="q"
                  defaultValue={query}
                  placeholder="Find a person, place, project…"
                  type="search"
                  className={`${inputClass} w-full pl-9`}
                />
              </label>
              <select
                name="kind"
                defaultValue={kind}
                className={selectClass}
                aria-label="Item type"
              >
                <option value="">All types</option>
                {['person', 'organization', 'project', 'place', 'event', 'date', 'topic'].map(
                  (value) => (
                    <option key={value} value={value}>
                      {entityKindLabel(value)}
                    </option>
                  ),
                )}
              </select>
              <button type="submit" className={btn.outline}>
                Find items
              </button>
            </form>
            <p className="mt-3 px-1 text-xs text-muted">
              {graph.matchingEntities.toLocaleString()} matching items
            </p>
            <nav
              className="mt-2 max-h-[42dvh] space-y-1 overflow-y-auto rounded-xl bg-sunken/35 p-1.5 lg:max-h-[calc(100dvh-17rem)]"
              aria-label="Knowledge items"
            >
              {graph.entities.map((entity) => (
                <Link
                  key={entity.id}
                  href={hrefFor({ q: query, kind, entity: entity.id })}
                  aria-current={entity.id === graph.selected?.id ? 'page' : undefined}
                  className={`block rounded-lg px-3 py-2.5 ${entity.id === graph.selected?.id ? 'bg-raised ring-1 ring-accent/30' : 'text-muted hover:bg-raised'}`}
                >
                  <span className="block truncate text-sm font-medium text-strong">
                    {readableKnowledgeLabel(entity.label)}
                  </span>
                  <span className="block text-xs text-muted">{entityKindLabel(entity.kind)}</span>
                </Link>
              ))}
            </nav>
            {graph.entityPages > 1 ? (
              <div className="mt-3 flex items-center justify-between gap-2 px-1 text-xs text-muted">
                <span>
                  Page {graph.entityPage} of {graph.entityPages}
                </span>
                <span className="flex gap-2">
                  {graph.entityPage > 1 ? (
                    <Link
                      className="underline"
                      href={hrefFor({ q: query, kind, page: graph.entityPage - 1 })}
                    >
                      Previous
                    </Link>
                  ) : null}
                  {graph.entityPage < graph.entityPages ? (
                    <Link
                      className="underline"
                      href={hrefFor({ q: query, kind, page: graph.entityPage + 1 })}
                    >
                      Next
                    </Link>
                  ) : null}
                </span>
              </div>
            ) : null}
          </aside>

          <main className="order-1 min-w-0 lg:order-2">
            {!graph.selected ? (
              <EmptyState>
                <Network className="mx-auto size-5 text-muted" />
                Search for an item, or add the first source-backed connection.
              </EmptyState>
            ) : (
              <>
                <section className={`${cardShellClass} p-4 sm:p-5`}>
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className={microLabelClass}>{entityKindLabel(graph.selected.kind)}</p>
                      <h2 className="mt-1 break-words font-display text-2xl font-semibold text-strong">
                        {readableKnowledgeLabel(graph.selected.label)}
                      </h2>
                      <p className="mt-1 text-sm text-muted">
                        {graph.selectedActiveRelationTotal.toLocaleString()} active connections
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <EditKnowledgeEntity entity={graph.selected} duplicates={graph.duplicates} />
                      <AddKnowledgeRelation
                        selected={graph.selected}
                        vocabulary={PREDICATE_VOCABULARY}
                      />
                    </div>
                  </div>
                </section>

                <section className="mt-7">
                  <div className="flex flex-wrap items-end justify-between gap-3">
                    <div>
                      <p className={microLabelClass}>
                        {mode === 'map' ? 'Focus map' : 'Relationships'}
                      </p>
                      <h2 className="mt-1 font-display text-2xl font-semibold text-strong">
                        {mode === 'map'
                          ? 'One meaningful neighbourhood at a time'
                          : 'What connects here'}
                      </h2>
                    </div>
                    <div className="flex gap-2">
                      <Link
                        href={hrefFor({ q: query, kind, entity: graph.selected.id })}
                        className={mode === 'relationships' ? btnSm.primary : btnSm.outline}
                      >
                        Relationships
                      </Link>
                      <Link
                        href={hrefFor({ q: query, kind, entity: graph.selected.id, mode: 'map' })}
                        className={`hidden md:inline-flex ${mode === 'map' ? btnSm.primary : btnSm.outline}`}
                      >
                        Map
                      </Link>
                    </div>
                  </div>
                  {mode === 'map' && map ? (
                    <>
                      <div className="mt-5 md:hidden">
                        <EmptyState>
                          The focus map is available on a larger screen. Relationships stay easy to
                          browse here.
                        </EmptyState>
                        <div className="mt-5">
                          <RelationshipList
                            relations={graph.relations}
                            locale={locale}
                            query={query}
                            kind={kind}
                            focusId={graph.selected.id}
                          />
                        </div>
                      </div>
                      <div className="mt-5 hidden md:block">
                        <div className="mb-4 flex flex-wrap gap-2">
                          {mapFamilies.map((item) => (
                            <Link
                              key={item.family}
                              href={hrefFor({
                                q: query,
                                kind,
                                entity: graph.selected?.id,
                                mode: 'map',
                                mapFamily: item.family,
                              })}
                              className={
                                item.family === selectedFamily ? btnSm.primary : btnSm.outline
                              }
                            >
                              {familyLabel(item.family)} {item.count}
                            </Link>
                          ))}
                        </div>
                        {!selectedFamily && map.neighborhood.total > 24 ? (
                          <EmptyState>
                            Choose a relationship family to map. This item has{' '}
                            {map.neighborhood.total.toLocaleString()} connections, so the map stays
                            focused and readable.
                          </EmptyState>
                        ) : (
                          <>
                            <p className="mb-3 text-sm text-muted">
                              Showing {map.neighborhood.edges.length} of {map.neighborhood.total}{' '}
                              matching connections. Select a node to open it; the map never expands
                              into a full graph.
                            </p>
                            <LocalMap
                              selected={graph.selected}
                              initialEdges={map.neighborhood.edges}
                              totalEdges={map.neighborhood.total}
                              query={query}
                              kind={kind}
                              view="map"
                            />
                          </>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="mt-5">
                      <RelationshipList
                        relations={graph.relations}
                        locale={locale}
                        query={query}
                        kind={kind}
                        focusId={graph.selected.id}
                      />
                    </div>
                  )}
                </section>
              </>
            )}
          </main>
        </div>
      )}
    </PageShell>
  );
}
