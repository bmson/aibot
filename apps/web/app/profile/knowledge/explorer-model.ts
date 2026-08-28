import type { PredicateSpec } from '@assistant/application';

/**
 * Pure grouping and expansion logic for the Explorer view — the vertical
 * relationship outline that replaced the radial map as the default. DOM-free
 * so the behaviour is unit-testable without rendering anything.
 */

export interface ExplorerEdge {
  id: string;
  predicate: string;
  /** True when the centre entity is the subject of the relation. */
  outbound: boolean;
  reviewStatus: 'unreviewed' | 'confirmed' | 'rejected';
  validFrom: string | null;
  validUntil: string | null;
  other: { id: string; label: string; kind: string };
}

export interface ExplorerGroup {
  /** Registry group id, or 'other' for custom predicates. */
  family: string;
  label: string;
  edges: ExplorerEdge[];
}

const FAMILY_LABELS: Record<string, string> = {
  family: 'Family',
  biography: 'Biography',
  'work and education': 'Work and education',
  events: 'Events',
  other: 'Other',
};

/** Registry group order, then Other last. Unknown groups sort by name. */
function familyRank(family: string, knownOrder: readonly string[]): number {
  const index = knownOrder.indexOf(family);
  if (index !== -1) return index;
  return family === 'other' ? knownOrder.length + 1 : knownOrder.length;
}

/** The family a predicate belongs to, from the typed registry. */
export function familyForPredicate(
  predicate: string,
  vocabulary: readonly PredicateSpec[],
): string {
  return vocabulary.find((spec) => spec.id === predicate)?.group ?? 'other';
}

/**
 * Group edges by predicate family: registry order for known families, custom
 * predicates under Other. Within a family, confirmed edges lead, then
 * alphabetical by neighbour label — stable, so expansion never reshuffles.
 */
export function groupEdges(
  edges: ExplorerEdge[],
  vocabulary: readonly PredicateSpec[],
): ExplorerGroup[] {
  const knownOrder = [...new Set(vocabulary.map((spec) => spec.group))];
  const byFamily = new Map<string, ExplorerEdge[]>();
  for (const edge of edges) {
    const family = familyForPredicate(edge.predicate, vocabulary);
    const list = byFamily.get(family) ?? [];
    list.push(edge);
    byFamily.set(family, list);
  }
  return [...byFamily.entries()]
    .sort((a, b) => familyRank(a[0], knownOrder) - familyRank(b[0], knownOrder))
    .map(([family, familyEdges]) => ({
      family,
      label: FAMILY_LABELS[family] ?? family,
      edges: [...familyEdges].sort(
        (a, b) =>
          (a.reviewStatus === 'confirmed' ? 0 : 1) - (b.reviewStatus === 'confirmed' ? 0 : 1) ||
          a.other.label.localeCompare(b.other.label),
      ),
    }));
}

export interface ExplorerExpansion {
  edges: ExplorerEdge[];
  total: number;
}

/**
 * The children an expansion contributes to a node, minus anything already on
 * its ancestor chain — the outline never loops back over the path above it,
 * which is how a cyclic graph stays a finite tree.
 */
export function expansionChildren(
  expansion: ExplorerExpansion,
  ancestorIds: readonly string[],
): ExplorerEdge[] {
  const blocked = new Set(ancestorIds);
  return expansion.edges.filter((edge) => !blocked.has(edge.other.id));
}

/** Edge count announced after expanding, for the polite live region. */
export function expansionAnnouncement(
  label: string,
  expansion: ExplorerExpansion,
  ancestorIds: readonly string[],
): string {
  const count = expansionChildren(expansion, ancestorIds).length;
  if (count === 0) return `No further connections around ${label}.`;
  return `Showing ${count} connection${count === 1 ? '' : 's'} around ${label}.`;
}
