import type { KnowledgeGraphNeighborEdge } from '@assistant/application';
import Link from 'next/link';
import {
  entityKindLabel,
  entityKindPaint,
  formatCanonicalDateKey,
  humanizePredicate,
} from '@/lib/knowledge';
import { focusRing, microLabelClass } from '@/lib/ui';

/**
 * The Details view: every active connection of the selected entity as one
 * compact table. This is the canonical scanning and assistive-technology view
 * — the Explorer and the map are richer, but this is complete, linear, and
 * readable at any degree. Review actions stay with the evidence cards below.
 */
export function KnowledgeGraphDetails({
  edges,
  total,
  hrefFor,
  locale,
}: {
  edges: KnowledgeGraphNeighborEdge[];
  total: number;
  hrefFor: (entityId: string) => string;
  locale: string;
}) {
  if (edges.length === 0) {
    return (
      <p className="rounded-xl bg-sunken/40 px-5 py-8 text-center text-sm text-muted">
        No active connections to list yet.
      </p>
    );
  }
  return (
    <div>
      <div className="overflow-x-auto rounded-xl ring-1 ring-edge/70">
        <table className="w-full min-w-[34rem] border-collapse bg-raised text-sm">
          <thead>
            <tr className="border-b border-edge bg-sunken/50 text-left">
              <th scope="col" className={`${microLabelClass} px-3 py-2 text-muted`}>
                <span className="sr-only">Direction</span>
                <span aria-hidden="true">Dir.</span>
              </th>
              <th scope="col" className={`${microLabelClass} px-3 py-2 text-muted`}>
                Relationship
              </th>
              <th scope="col" className={`${microLabelClass} px-3 py-2 text-muted`}>
                Entity
              </th>
              <th scope="col" className={`${microLabelClass} px-3 py-2 text-muted`}>
                Type
              </th>
              <th scope="col" className={`${microLabelClass} px-3 py-2 text-muted`}>
                Dates
              </th>
              <th scope="col" className={`${microLabelClass} px-3 py-2 text-muted`}>
                Status
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-edge/60">
            {edges.map((edge) => (
              <tr key={edge.id}>
                <td
                  className="px-3 py-2 text-muted"
                  aria-label={edge.outbound ? 'outgoing' : 'incoming'}
                >
                  <span aria-hidden="true">{edge.outbound ? '→' : '←'}</span>
                </td>
                <td className="px-3 py-2 text-muted">{humanizePredicate(edge.predicate)}</td>
                <td className="max-w-48 px-3 py-2">
                  <Link
                    href={hrefFor(edge.other.id)}
                    title={edge.other.label}
                    className={`inline-flex min-w-0 items-center gap-1.5 rounded font-medium text-strong underline-offset-2 hover:underline ${focusRing}`}
                  >
                    <span
                      aria-hidden="true"
                      className={`inline-block size-2 shrink-0 rounded-full ${
                        entityKindPaint(edge.other.kind).swatch
                      }`}
                    />
                    <span className="truncate">{edge.other.label}</span>
                  </Link>
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-muted">
                  {entityKindLabel(edge.other.kind)}
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-muted">
                  {edge.validFrom || edge.validUntil
                    ? `${edge.validFrom ? formatCanonicalDateKey(edge.validFrom, locale) : '?'} to ${
                        edge.validUntil ? formatCanonicalDateKey(edge.validUntil, locale) : 'now'
                      }`
                    : '—'}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {edge.reviewStatus === 'confirmed' ? (
                    <span className="text-muted">Confirmed</span>
                  ) : (
                    <span className="text-amber-700 dark:text-amber-300">Needs review</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {total > edges.length ? (
        <p className="mt-2 text-xs text-muted">
          Showing the first {edges.length.toLocaleString()} of {total.toLocaleString()} active
          connections. Evidence and review actions are in the cards below.
        </p>
      ) : null}
    </div>
  );
}
