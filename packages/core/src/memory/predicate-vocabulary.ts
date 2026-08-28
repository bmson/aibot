/**
 * The typed predicate vocabulary for the knowledge graph.
 *
 * One registry is the source of truth for three consumers that used to drift:
 * the extraction prompt (which predicates the model should name), the manual
 * add-relationship form (which suggestions it offers for a kind pair), and
 * review/traversal code that needs to know a predicate's direction, inverse,
 * and whether a time span is natural on it.
 *
 * This module is deliberately data-only: no database, no config, no imports —
 * knowledge-graph.ts builds on it, so it must never import back.
 */

export const GRAPH_ENTITY_KINDS = [
  'person',
  'organization',
  'project',
  'place',
  'event',
  'date',
  'topic',
] as const;
export type GraphEntityKind = (typeof GRAPH_ENTITY_KINDS)[number];

export type PredicateGroup = 'family' | 'biography' | 'work and education' | 'events';

export interface PredicateSpec {
  id: string;
  group: PredicateGroup;
  /** Kind pairs the predicate is meaningful for. */
  subjectKinds: readonly GraphEntityKind[];
  objectKinds: readonly GraphEntityKind[];
  /** Inverse wording for display and traversal; symmetric predicates need none. */
  inverse?: string;
  symmetric?: boolean;
  /** A start/end span (valid_from/valid_until) is natural on this predicate. */
  temporal?: boolean;
}

const PERSON = ['person'] as const;
const PERSON_TO_PERSON = { subjectKinds: PERSON, objectKinds: PERSON } as const;

export const PREDICATE_VOCABULARY: readonly PredicateSpec[] = [
  // ── Family ────────────────────────────────────────────────────────────────
  { id: 'father_of', group: 'family', ...PERSON_TO_PERSON, inverse: 'child_of' },
  { id: 'mother_of', group: 'family', ...PERSON_TO_PERSON, inverse: 'child_of' },
  { id: 'parent_of', group: 'family', ...PERSON_TO_PERSON, inverse: 'child_of' },
  { id: 'child_of', group: 'family', ...PERSON_TO_PERSON, inverse: 'parent_of' },
  { id: 'son_of', group: 'family', ...PERSON_TO_PERSON, inverse: 'parent_of' },
  { id: 'daughter_of', group: 'family', ...PERSON_TO_PERSON, inverse: 'parent_of' },
  { id: 'brother_of', group: 'family', ...PERSON_TO_PERSON, inverse: 'sibling_of' },
  { id: 'sister_of', group: 'family', ...PERSON_TO_PERSON, inverse: 'sibling_of' },
  { id: 'sibling_of', group: 'family', ...PERSON_TO_PERSON, symmetric: true },
  { id: 'grandfather_of', group: 'family', ...PERSON_TO_PERSON, inverse: 'grandchild_of' },
  { id: 'grandmother_of', group: 'family', ...PERSON_TO_PERSON, inverse: 'grandchild_of' },
  { id: 'grandparent_of', group: 'family', ...PERSON_TO_PERSON, inverse: 'grandchild_of' },
  { id: 'grandson_of', group: 'family', ...PERSON_TO_PERSON, inverse: 'grandparent_of' },
  { id: 'granddaughter_of', group: 'family', ...PERSON_TO_PERSON, inverse: 'grandparent_of' },
  { id: 'spouse_of', group: 'family', ...PERSON_TO_PERSON, symmetric: true, temporal: true },
  { id: 'partner_of', group: 'family', ...PERSON_TO_PERSON, symmetric: true, temporal: true },
  { id: 'uncle_of', group: 'family', ...PERSON_TO_PERSON, inverse: 'nephew_of' },
  { id: 'aunt_of', group: 'family', ...PERSON_TO_PERSON, inverse: 'niece_of' },
  { id: 'nephew_of', group: 'family', ...PERSON_TO_PERSON, inverse: 'uncle_of' },
  { id: 'niece_of', group: 'family', ...PERSON_TO_PERSON, inverse: 'aunt_of' },
  { id: 'cousin_of', group: 'family', ...PERSON_TO_PERSON, symmetric: true },

  // ── Biography ─────────────────────────────────────────────────────────────
  { id: 'born_on', group: 'biography', subjectKinds: PERSON, objectKinds: ['date'] },
  { id: 'born_in', group: 'biography', subjectKinds: PERSON, objectKinds: ['place'] },
  { id: 'grew_up_in', group: 'biography', subjectKinds: PERSON, objectKinds: ['place'] },
  {
    id: 'lives_in',
    group: 'biography',
    subjectKinds: PERSON,
    objectKinds: ['place'],
    temporal: true,
  },
  {
    id: 'met_at',
    group: 'biography',
    subjectKinds: PERSON,
    objectKinds: ['place', 'event'],
    symmetric: true,
  },
  { id: 'met_during', group: 'biography', subjectKinds: PERSON, objectKinds: ['event'] },
  // "Anna met Bjorn" itself — the where/when is met_at / met_during above.
  { id: 'met', group: 'biography', ...PERSON_TO_PERSON, symmetric: true },
  { id: 'engaged_on', group: 'biography', subjectKinds: PERSON, objectKinds: ['date'] },
  {
    id: 'married_on',
    group: 'biography',
    subjectKinds: PERSON,
    objectKinds: ['date'],
  },
  { id: 'divorced_on', group: 'biography', subjectKinds: PERSON, objectKinds: ['date'] },
  { id: 'died_on', group: 'biography', subjectKinds: PERSON, objectKinds: ['date'] },

  // ── Work and education ────────────────────────────────────────────────────
  {
    id: 'works_at',
    group: 'work and education',
    subjectKinds: PERSON,
    objectKinds: ['organization'],
    inverse: 'employs',
    temporal: true,
  },
  {
    id: 'worked_at',
    group: 'work and education',
    subjectKinds: PERSON,
    objectKinds: ['organization'],
    inverse: 'employed',
    temporal: true,
  },
  {
    id: 'studies_at',
    group: 'work and education',
    subjectKinds: PERSON,
    objectKinds: ['organization'],
    temporal: true,
  },
  {
    id: 'studied_at',
    group: 'work and education',
    subjectKinds: PERSON,
    objectKinds: ['organization'],
    temporal: true,
  },
  {
    id: 'graduated_from',
    group: 'work and education',
    subjectKinds: PERSON,
    objectKinds: ['organization'],
  },
  {
    id: 'interned_at',
    group: 'work and education',
    subjectKinds: PERSON,
    objectKinds: ['organization'],
    temporal: true,
  },
  {
    id: 'employs',
    group: 'work and education',
    subjectKinds: ['organization'],
    objectKinds: PERSON,
    inverse: 'works_at',
    temporal: true,
  },

  // ── Events ────────────────────────────────────────────────────────────────
  { id: 'attends', group: 'events', subjectKinds: PERSON, objectKinds: ['event'] },
  {
    id: 'attended',
    group: 'events',
    subjectKinds: PERSON,
    objectKinds: ['event'],
    inverse: 'attended_by',
  },
  { id: 'attended_by', group: 'events', subjectKinds: ['event'], objectKinds: PERSON },
  {
    id: 'happens_on',
    group: 'events',
    subjectKinds: ['event', 'project'],
    objectKinds: ['date'],
  },
  { id: 'happens_at', group: 'events', subjectKinds: ['event'], objectKinds: ['place'] },
  {
    id: 'starts_on',
    group: 'events',
    subjectKinds: ['event', 'project'],
    objectKinds: ['date'],
  },
  {
    id: 'ends_on',
    group: 'events',
    subjectKinds: ['event', 'project'],
    objectKinds: ['date'],
  },
];

const BY_ID = new Map(PREDICATE_VOCABULARY.map((spec) => [spec.id, spec]));

export function predicateSpec(id: string): PredicateSpec | undefined {
  return BY_ID.get(id);
}

/** Suggestions for one kind pair, in registry order. Empty means: type freely. */
export function predicateSuggestionsFor(subjectKind: string, objectKind: string): string[] {
  return PREDICATE_VOCABULARY.filter(
    (spec) =>
      (spec.subjectKinds as readonly string[]).includes(subjectKind) &&
      (spec.objectKinds as readonly string[]).includes(objectKind),
  ).map((spec) => spec.id);
}

/** The vocabulary as prompt lines, one per group: "- family: father_of, mother_of, …" */
export function extractionVocabularyLines(): string[] {
  const groups = new Map<PredicateGroup, string[]>();
  for (const spec of PREDICATE_VOCABULARY) {
    const list = groups.get(spec.group) ?? [];
    list.push(spec.id);
    groups.set(spec.group, list);
  }
  return [...groups.entries()].map(([group, ids]) => `- ${group}: ${ids.join(', ')}`);
}
