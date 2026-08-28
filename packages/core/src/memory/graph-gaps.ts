import {
  type Db,
  knowledgeGraphEntities,
  knowledgeGraphRelations,
  suggestions,
} from '@assistant/db';
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';

/**
 * What the assistant does not know yet, and could just ask about.
 *
 * The knowledge graph only ever grows by extraction: it reads what the owner
 * happened to say and records what was explicitly stated. That makes it
 * accurate and completely passive — it can hold "Anna is your sister" for a
 * year without ever noticing it has no idea where she lives, and it will never
 * be the one to bring it up.
 *
 * A gap here is a *structural* absence, computed from rows: an entity the graph
 * clearly cares about (it is well connected) that is missing a predicate its
 * kind normally carries, a relation extraction was unsure about, or two
 * entities that look like the same person. No model decides what is missing —
 * the vocabulary and the row counts do. That matters for the same reason the
 * briefing's inputs are structured: a model asked "what don't you know?" will
 * happily invent an interesting-sounding hole, and being asked a question built
 * on a false premise is worse than not being asked at all.
 *
 * The question itself is then posted as an ordinary notice in the owner's
 * thread. The reply is captured by the existing extraction → graph-sync
 * pipeline, so the loop closes with no new machinery: an answer is data, not
 * work, which is exactly why this is not a `suggestion` (accepting one enqueues
 * a task, which is the wrong shape for "she lives in Akureyri").
 */

/** Below this, an entity is too peripheral to be worth a question. */
const MIN_RELATIONS_TO_CARE = 2;
/** Never ask about the same gap twice, however long the owner ignores it. */
const ASKED_TTL_DAYS = 3650;
const MAX_CANDIDATES = 40;

export type GraphGapKind =
  | 'missing-predicate'
  | 'unreviewed-relation'
  | 'duplicate-entity'
  | 'unlinked-person';

export interface GraphGap {
  kind: GraphGapKind;
  /** Stable per gap, so an answered or ignored question is never re-asked. */
  key: string;
  /** The question, in the owner's terms. */
  question: string;
  /** Higher is asked first. */
  priority: number;
}

/**
 * Predicates worth noticing the absence of, by entity kind.
 *
 * Deliberately a short whitelist rather than "everything in the vocabulary
 * whose subjectKinds match": the vocabulary holds `divorced_on` and `died_on`,
 * and an assistant that notices it has not been told whether your sister is
 * dead has misunderstood the assignment. These are the ordinary, askable ones.
 */
const EXPECTED: Partial<Record<string, ReadonlyArray<{ predicate: string; ask: string }>>> = {
  person: [
    { predicate: 'lives_in', ask: 'where {name} lives' },
    { predicate: 'works_at', ask: 'where {name} works' },
  ],
  organization: [{ predicate: 'based_in', ask: 'where {name} is based' }],
  project: [{ predicate: 'starts_on', ask: 'when {name} starts' }],
};

/** Predicates that satisfy an expectation, including the obvious equivalents. */
const SATISFIED_BY: Record<string, readonly string[]> = {
  lives_in: ['lives_in', 'born_in', 'grew_up_in'],
  works_at: ['works_at', 'worked_at', 'studies_at', 'studied_at', 'interned_at'],
  based_in: ['based_in'],
  starts_on: ['starts_on', 'ends_on'],
};

/**
 * Gaps worth asking about, most valuable first.
 *
 * Everything is read in a handful of grouped queries rather than per entity:
 * this runs on a schedule against a graph that may hold thousands of rows, and
 * a question is not worth an N+1.
 */
export async function findGraphGaps(db: Db, agentId: string): Promise<GraphGap[]> {
  // Entities the graph actually leans on, by how connected they are. An entity
  // mentioned once is not something the owner wants to be quizzed about.
  const connected = await db
    .select({
      id: knowledgeGraphEntities.id,
      label: sql<string>`coalesce(nullif(${knowledgeGraphEntities.preferredLabel}, ''), ${knowledgeGraphEntities.label})`,
      kind: knowledgeGraphEntities.kind,
      contactId: knowledgeGraphEntities.contactId,
      degree: count(knowledgeGraphRelations.id),
    })
    .from(knowledgeGraphEntities)
    .leftJoin(
      knowledgeGraphRelations,
      eq(knowledgeGraphRelations.subjectEntityId, knowledgeGraphEntities.id),
    )
    .where(eq(knowledgeGraphEntities.agentId, agentId))
    .groupBy(
      knowledgeGraphEntities.id,
      knowledgeGraphEntities.preferredLabel,
      knowledgeGraphEntities.label,
      knowledgeGraphEntities.kind,
      knowledgeGraphEntities.contactId,
    )
    .having(sql`count(${knowledgeGraphRelations.id}) >= ${MIN_RELATIONS_TO_CARE}`)
    .orderBy(asc(knowledgeGraphEntities.label))
    .limit(MAX_CANDIDATES);

  if (connected.length === 0) return [];

  const ids = connected.map((row) => row.id);
  const held = await db
    .select({
      subjectEntityId: knowledgeGraphRelations.subjectEntityId,
      predicate: knowledgeGraphRelations.predicate,
      reviewStatus: knowledgeGraphRelations.reviewStatus,
      id: knowledgeGraphRelations.id,
      confidence: knowledgeGraphRelations.confidence,
    })
    .from(knowledgeGraphRelations)
    .where(
      and(
        eq(knowledgeGraphRelations.agentId, agentId),
        inArray(knowledgeGraphRelations.subjectEntityId, ids),
      ),
    );

  const predicatesBySubject = new Map<string, Set<string>>();
  for (const row of held) {
    const set = predicatesBySubject.get(row.subjectEntityId) ?? new Set<string>();
    set.add(row.predicate);
    predicatesBySubject.set(row.subjectEntityId, set);
  }

  const gaps: GraphGap[] = [];

  for (const entity of connected) {
    const has = predicatesBySubject.get(entity.id) ?? new Set<string>();
    for (const expectation of EXPECTED[entity.kind] ?? []) {
      const satisfying = SATISFIED_BY[expectation.predicate] ?? [expectation.predicate];
      if (satisfying.some((predicate) => has.has(predicate))) continue;
      gaps.push({
        kind: 'missing-predicate',
        key: `gap:missing:${entity.id}:${expectation.predicate}`,
        question: `I do not think you have ever told me ${expectation.ask.replace('{name}', entity.label)}. Would you like me to remember it?`,
        // The better connected the entity, the more a gap in it costs.
        priority: 40 + Math.min(Number(entity.degree), 20),
      });
    }

    // A person the graph knows well but that is not linked to a contact row
    // cannot be reached, reminded about, or matched to incoming mail.
    if (entity.kind === 'person' && !entity.contactId) {
      gaps.push({
        kind: 'unlinked-person',
        key: `gap:unlinked:${entity.id}`,
        question: `I have notes about ${entity.label} but no contact details. Do you want me to keep track of how to reach them?`,
        priority: 30,
      });
    }
  }

  // Extraction was unsure. Confirming one of these is cheap for the owner and
  // upgrades a hedged fact into a usable one.
  const unsure = held
    .filter((row) => row.reviewStatus === 'unreviewed' && Number(row.confidence) < 0.6)
    .slice(0, 5);
  const labelById = new Map(connected.map((row) => [row.id, row.label]));
  for (const row of unsure) {
    const label = labelById.get(row.subjectEntityId);
    if (!label) continue;
    gaps.push({
      kind: 'unreviewed-relation',
      key: `gap:unsure:${row.id}`,
      question: `I recorded that ${label} ${row.predicate.replace(/_/g, ' ')} something, but I was not confident. Is that right?`,
      priority: 20,
    });
  }

  return gaps.sort((a, b) => b.priority - a.priority || a.key.localeCompare(b.key));
}

/**
 * The gap to ask about now, or nothing.
 *
 * "Already asked" is recorded in `suggestions` purely as a dedupe ledger — its
 * `(agent_id, source_ref)` unique index is exactly the fence needed, and reusing
 * it costs no migration. The row is never surfaced as a card: the question goes
 * out as a notice, because a question's answer is data, not work.
 */
export async function nextUnaskedGap(
  db: Db,
  agentId: string,
  gaps: readonly GraphGap[],
): Promise<GraphGap | null> {
  if (gaps.length === 0) return null;
  const asked = await db
    .select({ sourceRef: suggestions.sourceRef })
    .from(suggestions)
    .where(
      and(
        eq(suggestions.agentId, agentId),
        inArray(
          suggestions.sourceRef,
          gaps.map((gap) => gap.key),
        ),
      ),
    );
  const seen = new Set(asked.map((row) => row.sourceRef));
  return gaps.find((gap) => !seen.has(gap.key)) ?? null;
}

/** Mark a gap asked. Returns false when another instance got there first. */
export async function markGapAsked(
  db: Db,
  agentId: string,
  gap: GraphGap,
  now = new Date(),
): Promise<boolean> {
  const [row] = await db
    .insert(suggestions)
    .values({
      agentId,
      summary: gap.question.slice(0, 500),
      // Never promoted: this row exists to remember that the question was put,
      // not to offer work. Dismissed on creation so it can never surface as an
      // open card the owner is expected to accept.
      proposedAction: 'Answered in conversation; nothing to run.',
      origin: 'curiosity',
      sourceRef: gap.key,
      status: 'dismissed',
      expiresAt: new Date(now.getTime() + ASKED_TTL_DAYS * 24 * 3600 * 1000),
    })
    .onConflictDoNothing({ target: [suggestions.agentId, suggestions.sourceRef] })
    .returning({ id: suggestions.id });
  return Boolean(row);
}
