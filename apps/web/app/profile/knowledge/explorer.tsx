'use client';

import type { PredicateSpec } from '@assistant/application';
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { loadKnowledgeNeighborhood } from '@/app/profile/knowledge/actions';
import {
  type ExplorerEdge,
  type ExplorerExpansion,
  expansionAnnouncement,
  expansionChildren,
  groupEdges,
} from '@/app/profile/knowledge/explorer-model';
import { entityHref } from '@/app/profile/knowledge/local-map-model';
import {
  entityKindLabel,
  entityKindPaint,
  formatCanonicalDateKey,
  humanizePredicate,
} from '@/lib/knowledge';
import { focusRing } from '@/lib/ui';

/**
 * The Explorer: the selected entity's relationships as a vertical, expandable
 * outline grouped by predicate family. This is the default view — a graph of
 * this shape (cyclic, multi-parent) reads better as a tree you open branch by
 * branch than as a radial drawing.
 *
 * Expansion fetches one hop further per row through the same server action
 * the map uses. A row on its own ancestor chain renders as a plain "already
 * shown" back-reference, which is what keeps a cyclic graph a finite outline.
 */

function SpanText({
  validFrom,
  validUntil,
  locale,
}: {
  validFrom: string | null;
  validUntil: string | null;
  locale: string;
}) {
  if (!validFrom && !validUntil) return null;
  return (
    <span className="text-muted">
      {' '}
      · {validFrom ? formatCanonicalDateKey(validFrom, locale) : 'unknown start'} to{' '}
      {validUntil ? formatCanonicalDateKey(validUntil, locale) : 'now'}
    </span>
  );
}

function ExplorerNode({
  edge,
  ancestors,
  expansions,
  pendingId,
  onExpand,
  hrefFor,
  locale,
}: {
  edge: ExplorerEdge;
  ancestors: readonly string[];
  expansions: Record<string, ExplorerExpansion>;
  pendingId: string | null;
  onExpand: (node: ExplorerEdge['other'], ancestors: readonly string[]) => void;
  hrefFor: (entityId: string) => string;
  locale: string;
}) {
  const expansion = expansions[edge.other.id];
  const children = expansion ? expansionChildren(expansion, [...ancestors, edge.other.id]) : [];
  const paint = entityKindPaint(edge.other.kind);
  const isPending = pendingId === edge.other.id;
  return (
    <li className="min-w-0">
      <div className="flex min-w-0 items-center gap-2 py-1.5">
        <button
          type="button"
          aria-expanded={expansion !== undefined}
          aria-label={
            expansion
              ? `Hide connections around ${edge.other.label}`
              : `Show connections around ${edge.other.label}`
          }
          disabled={pendingId !== null && !isPending}
          onClick={() => onExpand(edge.other, [...ancestors, edge.other.id])}
          className={`inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted motion-safe:transition-colors hover:bg-sunken hover:text-strong disabled:opacity-50 ${focusRing}`}
        >
          <ChevronRight
            className={`size-3.5 motion-safe:transition-transform ${expansion ? 'rotate-90' : ''}`}
            aria-hidden="true"
          />
        </button>
        <span
          aria-hidden="true"
          className={`inline-block size-2 shrink-0 rounded-full ${paint.swatch}`}
        />
        <span className="shrink-0 text-xs text-muted">
          <span aria-hidden="true">{edge.outbound ? '→' : '←'}</span>
          <span className="sr-only">{edge.outbound ? 'outgoing' : 'incoming'}</span>
        </span>
        <span className="shrink-0 text-sm text-muted">{humanizePredicate(edge.predicate)}</span>
        <a
          href={hrefFor(edge.other.id)}
          className={`min-w-0 truncate rounded text-sm font-medium text-strong underline-offset-2 hover:underline ${focusRing}`}
          title={edge.other.label}
        >
          {edge.other.label}
        </a>
        <span className="shrink-0 text-xs text-muted">{entityKindLabel(edge.other.kind)}</span>
        <span className="min-w-0 truncate text-xs">
          <SpanText validFrom={edge.validFrom} validUntil={edge.validUntil} locale={locale} />
          {edge.reviewStatus !== 'confirmed' ? (
            <span className="text-amber-700 dark:text-amber-300"> · needs review</span>
          ) : null}
        </span>
      </div>
      {expansion ? (
        <ul className="ml-4 border-l border-edge pl-4">
          {children.length === 0 ? (
            <li className="py-1.5 text-xs text-muted">
              {isPending
                ? 'Loading…'
                : 'No further connections — everything it touches is already shown above.'}
            </li>
          ) : (
            children.map((child) => (
              <ExplorerNode
                key={child.id}
                edge={child}
                ancestors={[...ancestors, edge.other.id]}
                expansions={expansions}
                pendingId={pendingId}
                onExpand={onExpand}
                hrefFor={hrefFor}
                locale={locale}
              />
            ))
          )}
        </ul>
      ) : null}
    </li>
  );
}

export function KnowledgeGraphExplorer({
  selected,
  edges,
  total,
  vocabulary,
  query,
  kind,
  locale,
}: {
  selected: { id: string; label: string; kind: string };
  edges: ExplorerEdge[];
  total: number;
  vocabulary: readonly PredicateSpec[];
  query: string;
  kind: string;
  locale: string;
}) {
  const [expansions, setExpansions] = useState<Record<string, ExplorerExpansion>>({});
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');

  // Reset when the server-selected entity changes (navigation or revalidation).
  const propsKey = `${selected.id}|${edges.map((edge) => `${edge.id}:${edge.reviewStatus}`).join(',')}`;
  const [seenPropsKey, setSeenPropsKey] = useState(propsKey);
  if (seenPropsKey !== propsKey) {
    setSeenPropsKey(propsKey);
    setExpansions({});
    setPendingId(null);
  }

  const hrefFor = (entityId: string) => entityHref(entityId, query, kind, 'explorer');
  const groups = groupEdges(edges, vocabulary);

  const handleExpand = async (node: ExplorerEdge['other'], ancestors: readonly string[]) => {
    // Collapse on a second press.
    if (expansions[node.id]) {
      setExpansions((previous) => {
        const next = { ...previous };
        delete next[node.id];
        return next;
      });
      return;
    }
    if (pendingId) return;
    setPendingId(node.id);
    try {
      const result = await loadKnowledgeNeighborhood(node.id, 50);
      const expansion: ExplorerExpansion = { edges: result.edges, total: result.total };
      setExpansions((previous) => ({ ...previous, [node.id]: expansion }));
      setAnnounce(expansionAnnouncement(node.label, expansion, ancestors));
    } catch {
      setAnnounce(`Could not load connections around ${node.label}. Try again.`);
    } finally {
      setPendingId(null);
    }
  };

  if (groups.length === 0) {
    return (
      <p className="rounded-xl bg-sunken/40 px-5 py-8 text-center text-sm text-muted">
        No active connections to explore yet.
      </p>
    );
  }

  return (
    <div>
      {groups.map((group) => (
        <section key={group.family} className="mt-4 first:mt-0">
          <h3 className="font-mono text-xs font-medium tracking-[0.08em] text-muted uppercase">
            {group.label}
            <span className="ml-2 text-muted/70">{group.edges.length}</span>
          </h3>
          <ul className="mt-1 divide-y divide-edge/50">
            {group.edges.map((edge) => (
              <ExplorerNode
                key={edge.id}
                edge={edge}
                ancestors={[selected.id]}
                expansions={expansions}
                pendingId={pendingId}
                onExpand={handleExpand}
                hrefFor={hrefFor}
                locale={locale}
              />
            ))}
          </ul>
        </section>
      ))}

      {total > edges.length ? (
        <p className="mt-3 text-xs text-muted">
          Showing the first {edges.length.toLocaleString()} of {total.toLocaleString()} active
          connections. Open an item to explore further.
        </p>
      ) : null}

      <div aria-live="polite" role="status" className="sr-only">
        {announce}
      </div>
    </div>
  );
}
