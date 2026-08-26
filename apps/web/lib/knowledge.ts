/**
 * Presentation vocabulary for the knowledge graph. Server and client components
 * both read this, so it stays free of package imports — `apps/web` may not reach
 * past `@assistant/application`, and a `'use client'` file may not reach a
 * package at all (scripts/check-boundaries.ts).
 *
 * The domain list of kinds lives in core (`GRAPH_ENTITY_KINDS`) and is enforced
 * by the schema CHECK; this file only decides how those kinds are *worded* and
 * *coloured*, which is why an unknown kind renders rather than throws.
 */

/** Ordered for the add-relationship pickers: the kinds people reach for first. */
export const ENTITY_KIND_LABELS: Record<string, string> = {
  person: 'Person',
  organization: 'Organization',
  project: 'Project',
  place: 'Place',
  event: 'Event',
  date: 'Date',
  topic: 'Topic',
};

export const ENTITY_KINDS: readonly string[] = Object.keys(ENTITY_KIND_LABELS);

/**
 * "organization" → "Organization". A kind the schema gained but this map has
 * not is shown sentence-cased rather than dropped, so a new kind degrades to a
 * readable label instead of an empty cell.
 */
export function entityKindLabel(kind: string): string {
  const known = ENTITY_KIND_LABELS[kind];
  if (known) return known;
  const clean = kind.replaceAll('_', ' ').trim();
  return clean ? clean.charAt(0).toLocaleUpperCase() + clean.slice(1) : 'Item';
}

/**
 * Predicates are stored snake_case (`cleanPredicate` in core). They read as a
 * verb phrase inside a path — "Ada — works at → the Analytical Engine" — so the
 * humanized form stays lowercase; callers that need it to open a line capitalize
 * with `sentenceCase`.
 */
export function humanizePredicate(predicate: string): string {
  return predicate.replaceAll('_', ' ').replace(/\s+/g, ' ').trim();
}

export function sentenceCase(value: string): string {
  return value ? value.charAt(0).toLocaleUpperCase() + value.slice(1) : value;
}

/**
 * Per-kind SVG colours for the local map. Palette colours rather than theme
 * tokens — the seven kinds must stay distinguishable from each other, which one
 * accent hue cannot do — so each carries an explicit `dark:` variant, matching
 * how `pillTones` in lib/ui.tsx handles the same problem for badges.
 */
export interface EntityKindPaint {
  /** Node body + ring. */
  node: string;
  /** The matching legend swatch fill, without the ring. */
  swatch: string;
}

const KIND_PAINT: Record<string, EntityKindPaint> = {
  person: {
    node: 'fill-sky-100 stroke-sky-500 dark:fill-sky-950 dark:stroke-sky-400',
    swatch: 'bg-sky-500',
  },
  organization: {
    node: 'fill-violet-100 stroke-violet-500 dark:fill-violet-950 dark:stroke-violet-400',
    swatch: 'bg-violet-500',
  },
  project: {
    node: 'fill-amber-100 stroke-amber-500 dark:fill-amber-950 dark:stroke-amber-400',
    swatch: 'bg-amber-500',
  },
  place: {
    node: 'fill-rose-100 stroke-rose-500 dark:fill-rose-950 dark:stroke-rose-400',
    swatch: 'bg-rose-500',
  },
  event: {
    node: 'fill-cyan-100 stroke-cyan-500 dark:fill-cyan-950 dark:stroke-cyan-400',
    swatch: 'bg-cyan-500',
  },
  date: {
    node: 'fill-indigo-100 stroke-indigo-500 dark:fill-indigo-950 dark:stroke-indigo-400',
    swatch: 'bg-indigo-500',
  },
  topic: {
    node: 'fill-teal-100 stroke-teal-500 dark:fill-teal-950 dark:stroke-teal-400',
    swatch: 'bg-teal-500',
  },
};

const FALLBACK_PAINT: EntityKindPaint = {
  node: 'fill-zinc-100 stroke-zinc-400 dark:fill-zinc-900 dark:stroke-zinc-500',
  swatch: 'bg-zinc-400',
};

export function entityKindPaint(kind: string): EntityKindPaint {
  return KIND_PAINT[kind] ?? FALLBACK_PAINT;
}

/**
 * Node labels are drawn as SVG text, which has no `text-overflow`, so the clip
 * has to happen in the string. Kept here beside the paint so the map's two
 * label decisions stay together.
 */
export function clipNodeLabel(label: string, max = 18): string {
  const clean = label.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}
