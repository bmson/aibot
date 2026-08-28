import { loadConfig } from '@assistant/config';
import { getAgent } from '@assistant/core/chat';
import {
  countRelativeDateSources,
  createOwnerKnowledgeGraphFact,
  GRAPH_ENTITY_KINDS,
  type GraphEntityKind,
  meanExtractionCostUsd,
  mergeGraphEntities,
  requeueRelativeDateSources,
  retryQuarantinedKnowledgeGraphSources as retryQuarantinedSources,
  retypeGraphEntity,
} from '@assistant/core/memory/knowledge-graph';
import {
  type Db,
  knowledgeGraphEntities,
  knowledgeGraphRelations,
  knowledgeGraphSources,
  memories,
  namePrefixMatch,
} from '@assistant/db';
import { and, asc, count, desc, eq, gt, ilike, isNull, ne, or, sql } from 'drizzle-orm';
import { type AnyPgColumn, alias } from 'drizzle-orm/pg-core';
import type { EmbeddingPort } from './profile/commands.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type KnowledgeGraphReviewStatus = 'unreviewed' | 'confirmed' | 'rejected';

export interface KnowledgeGraphEntityView {
  id: string;
  label: string;
  kind: string;
  canonicalKey: string;
}

export interface KnowledgeGraphRelationView {
  id: string;
  subject: KnowledgeGraphEntityView;
  predicate: string;
  object: KnowledgeGraphEntityView;
  confidence: number;
  reviewStatus: KnowledgeGraphReviewStatus;
  reviewedAt: Date | null;
  /** Temporal qualifiers as canonical date keys, when the source states a span. */
  validFrom: string | null;
  validUntil: string | null;
  source: {
    memoryId: string;
    content: string;
    createdAt: Date;
    ownerConfirmed: boolean;
    originTrust: string;
  };
}

/** An advisory merge hint, mirroring the contact-level duplicate suggestions. */
export interface KnowledgeGraphDuplicate {
  targetId: string;
  label: string;
  kind: string;
  reason: string;
}

export interface KnowledgeGraphOverview {
  totalEntities: number;
  totalRelations: number;
  unreviewedRelations: number;
  pendingSources: number;
  quarantinedSources: number;
  /**
   * What the pending backlog is expected to cost to extract, priced from recent
   * actuals, and roughly how long it takes to drain at the configured batch
   * size. Null when there is too little history to price honestly — a guess
   * dressed as a number is worse than no number.
   */
  pendingCostUsd: number | null;
  pendingRuns: number;
  /**
   * Sources still carrying relative date wording that the free backfill could
   * not resolve. Re-extracting them costs money, so it is surfaced as a choice
   * rather than queued automatically.
   */
  relativeDateSources: number;
  entities: KnowledgeGraphEntityView[];
  /** Entities matching the current search — the true count, not the page size. */
  matchingEntities: number;
  entityPage: number;
  entityPages: number;
  selected: KnowledgeGraphEntityView | null;
  relations: KnowledgeGraphRelationView[];
  /**
   * Every edge incident to the selected entity, including the ones past the
   * page cap. The header used to print `relations.length`, which silently
   * reported the cap as the degree.
   */
  selectedRelationTotal: number;
  /**
   * Incident edges that are not stale — what the local map actually draws from.
   * Separate from the total because the map is built from one capped page of
   * relations, so its own length would report the cap as the degree.
   */
  selectedActiveRelationTotal: number;
  duplicates: KnowledgeGraphDuplicate[];
}

function displayLabel<T extends { preferredLabel: AnyPgColumn; label: AnyPgColumn }>(entity: T) {
  return sql<string>`COALESCE(${entity.preferredLabel}, ${entity.label})`;
}

/**
 * Sort key for owner-facing entity lists. Ordering on the raw label leaves the
 * result at the mercy of the deployment's Postgres collation — under `C` an
 * uppercase "Zebra" sorts before a lowercase "apple" — so the case is folded
 * here rather than assumed away.
 */
function sortLabel<T extends { preferredLabel: AnyPgColumn; label: AnyPgColumn }>(entity: T) {
  return sql`LOWER(${displayLabel(entity)})`;
}

/** One page of the entity sidebar. Matches listMemoryLibrary's page size. */
const ENTITY_PAGE_SIZE = 60;
/** Edges rendered for the selected entity before the list is capped. */
const RELATION_LIMIT = 80;

function cleanSearch(query: string): string {
  return query.trim().slice(0, 120).replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function asReviewStatus(value: string): KnowledgeGraphReviewStatus {
  return value === 'confirmed' || value === 'rejected' ? value : 'unreviewed';
}

/**
 * The domain owns the kind list; a URL or form can carry any string, so
 * unknown values degrade to "no filter" rather than silently zeroing the list
 * — a garbage `?kind=` looking like data loss is the failure this avoids.
 */
export function asGraphEntityKind(value: string | undefined): GraphEntityKind | undefined {
  return value && (GRAPH_ENTITY_KINDS as readonly string[]).includes(value)
    ? (value as GraphEntityKind)
    : undefined;
}

/** Owner-facing, bounded graph inspection. It reads only source-backed edges. */
export async function getKnowledgeGraphOverview(
  db: Db,
  input: {
    query?: string;
    kind?: string;
    entityId?: string;
    page?: number;
    pageSize?: number;
  } = {},
): Promise<KnowledgeGraphOverview> {
  const agent = await getAgent(db);
  const query = cleanSearch(input.query ?? '');
  const kind = asGraphEntityKind(input.kind);
  const pageSize = input.pageSize ?? ENTITY_PAGE_SIZE;
  const entityCondition = and(
    eq(knowledgeGraphEntities.agentId, agent.id),
    kind ? eq(knowledgeGraphEntities.kind, kind) : undefined,
    query ? ilike(displayLabel(knowledgeGraphEntities), `%${query}%`) : undefined,
  );
  // The match count has to be known before the page can be clamped, so it is
  // resolved first rather than alongside the row fetch.
  const [matchingRow] = await db
    .select({ value: count() })
    .from(knowledgeGraphEntities)
    .where(entityCondition);
  const matchingEntities = Number(matchingRow?.value ?? 0);
  const entityPages = Math.max(1, Math.ceil(matchingEntities / pageSize));
  const requestedPage =
    Number.isFinite(input.page) && (input.page ?? 0) > 0 ? (input.page ?? 1) : 1;
  const entityPage = Math.min(requestedPage, entityPages);
  const [
    entityRows,
    [entityTotal],
    [relationTotal],
    [unreviewedTotal],
    [pendingSources],
    [quarantinedSources],
  ] = await Promise.all([
    db
      .select({
        id: knowledgeGraphEntities.id,
        label: displayLabel(knowledgeGraphEntities),
        kind: knowledgeGraphEntities.kind,
        canonicalKey: knowledgeGraphEntities.canonicalKey,
      })
      .from(knowledgeGraphEntities)
      .where(entityCondition)
      .orderBy(asc(sortLabel(knowledgeGraphEntities)))
      .limit(pageSize)
      .offset((entityPage - 1) * pageSize),
    db
      .select({ value: count() })
      .from(knowledgeGraphEntities)
      .where(eq(knowledgeGraphEntities.agentId, agent.id)),
    db
      .select({ value: count() })
      .from(knowledgeGraphRelations)
      .where(eq(knowledgeGraphRelations.agentId, agent.id)),
    db
      .select({ value: count() })
      .from(knowledgeGraphRelations)
      .where(
        and(
          eq(knowledgeGraphRelations.agentId, agent.id),
          eq(knowledgeGraphRelations.reviewStatus, 'unreviewed'),
        ),
      ),
    db
      .select({ value: count() })
      .from(memories)
      .leftJoin(knowledgeGraphSources, eq(knowledgeGraphSources.memoryId, memories.id))
      .where(
        and(
          eq(memories.agentId, agent.id),
          eq(memories.category, 'knowledge'),
          eq(memories.quarantined, false),
          or(isNull(memories.expiresAt), gt(memories.expiresAt, sql`now()`)),
          or(
            isNull(knowledgeGraphSources.memoryId),
            sql`${knowledgeGraphSources.contentHash} IS DISTINCT FROM ${memories.contentHash}`,
            sql`${knowledgeGraphSources.subjectContactId} IS DISTINCT FROM ${memories.subjectContactId}`,
            eq(knowledgeGraphSources.status, 'failed'),
          ),
        ),
      ),
    db
      .select({ value: count() })
      .from(knowledgeGraphSources)
      .innerJoin(memories, eq(memories.id, knowledgeGraphSources.memoryId))
      .where(and(eq(memories.agentId, agent.id), eq(knowledgeGraphSources.status, 'quarantined'))),
  ]);
  const entities = entityRows.map((row) => ({ ...row }));
  const pending = Number(pendingSources?.value ?? 0);
  const meanCost = pending > 0 ? await meanExtractionCostUsd(db) : null;
  const pendingCostUsd = meanCost === null ? null : pending * meanCost;
  const batchLimit = loadConfig().GRAPH_SYNC_BATCH_LIMIT;
  const pendingRuns = Math.ceil(pending / batchLimit);
  const relativeDateSources = await countRelativeDateSources(db, agent.id);
  const requestedId = input.entityId && UUID_RE.test(input.entityId) ? input.entityId : null;
  const selected =
    (requestedId
      ? (entities.find((entity) => entity.id === requestedId) ??
        // The fallback lookup is deliberately unfiltered by kind: a deep link
        // like ?entity=<id>&kind=person must still open a date entity, or
        // changing the filter would make a shared link lose its subject.
        (
          await db
            .select({
              id: knowledgeGraphEntities.id,
              label: displayLabel(knowledgeGraphEntities),
              kind: knowledgeGraphEntities.kind,
              canonicalKey: knowledgeGraphEntities.canonicalKey,
            })
            .from(knowledgeGraphEntities)
            .where(
              and(
                eq(knowledgeGraphEntities.agentId, agent.id),
                eq(knowledgeGraphEntities.id, requestedId),
              ),
            )
            .limit(1)
        )[0])
      : entities[0]) ?? null;

  if (!selected) {
    return {
      totalEntities: Number(entityTotal?.value ?? 0),
      totalRelations: Number(relationTotal?.value ?? 0),
      unreviewedRelations: Number(unreviewedTotal?.value ?? 0),
      pendingSources: pending,
      quarantinedSources: Number(quarantinedSources?.value ?? 0),
      pendingCostUsd,
      pendingRuns,
      relativeDateSources,
      entities,
      matchingEntities,
      entityPage,
      entityPages,
      selected: null,
      relations: [],
      selectedRelationTotal: 0,
      selectedActiveRelationTotal: 0,
      duplicates: [],
    };
  }

  const subject = alias(knowledgeGraphEntities, 'knowledge_graph_subject');
  const object = alias(knowledgeGraphEntities, 'knowledge_graph_object');
  const incidentToSelected = and(
    eq(knowledgeGraphRelations.agentId, agent.id),
    or(
      eq(knowledgeGraphRelations.subjectEntityId, selected.id),
      eq(knowledgeGraphRelations.objectEntityId, selected.id),
    ),
  );
  const [relationRows, [selectedRelationRow], [selectedActiveRow], duplicates] = await Promise.all([
    db
      .select({
        id: knowledgeGraphRelations.id,
        predicate: knowledgeGraphRelations.predicate,
        confidence: knowledgeGraphRelations.confidence,
        reviewStatus: knowledgeGraphRelations.reviewStatus,
        reviewedAt: knowledgeGraphRelations.reviewedAt,
        validFrom: knowledgeGraphRelations.validFrom,
        validUntil: knowledgeGraphRelations.validUntil,
        subjectId: subject.id,
        subjectLabel: displayLabel(subject),
        subjectKind: subject.kind,
        subjectCanonicalKey: subject.canonicalKey,
        objectId: object.id,
        objectLabel: displayLabel(object),
        objectKind: object.kind,
        objectCanonicalKey: object.canonicalKey,
        sourceMemoryId: memories.id,
        sourceContent: memories.content,
        sourceCreatedAt: memories.createdAt,
        sourceOwnerConfirmed: memories.ownerConfirmed,
        sourceOriginTrust: memories.originTrust,
      })
      .from(knowledgeGraphRelations)
      .innerJoin(subject, eq(knowledgeGraphRelations.subjectEntityId, subject.id))
      .innerJoin(object, eq(knowledgeGraphRelations.objectEntityId, object.id))
      .innerJoin(memories, eq(knowledgeGraphRelations.sourceMemoryId, memories.id))
      .where(incidentToSelected)
      .orderBy(
        asc(
          sql`CASE ${knowledgeGraphRelations.reviewStatus} WHEN 'unreviewed' THEN 0 WHEN 'confirmed' THEN 1 ELSE 2 END`,
        ),
        desc(knowledgeGraphRelations.createdAt),
      )
      .limit(RELATION_LIMIT),
    db.select({ value: count() }).from(knowledgeGraphRelations).where(incidentToSelected),
    db
      .select({ value: count() })
      .from(knowledgeGraphRelations)
      .where(and(incidentToSelected, ne(knowledgeGraphRelations.reviewStatus, 'rejected'))),
    findDuplicateKnowledgeGraphEntities(db, selected),
  ]);
  const relations = relationRows.map((row) => ({
    id: row.id,
    subject: {
      id: row.subjectId,
      label: row.subjectLabel,
      kind: row.subjectKind,
      canonicalKey: row.subjectCanonicalKey,
    },
    predicate: row.predicate,
    object: {
      id: row.objectId,
      label: row.objectLabel,
      kind: row.objectKind,
      canonicalKey: row.objectCanonicalKey,
    },
    confidence: Number(row.confidence),
    reviewStatus: asReviewStatus(row.reviewStatus),
    reviewedAt: row.reviewedAt,
    validFrom: row.validFrom,
    validUntil: row.validUntil,
    source: {
      memoryId: row.sourceMemoryId,
      content: row.sourceContent,
      createdAt: row.sourceCreatedAt,
      ownerConfirmed: row.sourceOwnerConfirmed,
      originTrust: row.sourceOriginTrust,
    },
  }));
  return {
    totalEntities: Number(entityTotal?.value ?? 0),
    totalRelations: Number(relationTotal?.value ?? 0),
    unreviewedRelations: Number(unreviewedTotal?.value ?? 0),
    pendingSources: pending,
    quarantinedSources: Number(quarantinedSources?.value ?? 0),
    pendingCostUsd,
    pendingRuns,
    relativeDateSources,
    entities,
    matchingEntities,
    entityPage,
    entityPages,
    selected,
    relations,
    selectedRelationTotal: Number(selectedRelationRow?.value ?? 0),
    selectedActiveRelationTotal: Number(selectedActiveRow?.value ?? 0),
    duplicates,
  };
}

/** One edge as the local map draws it: the neighbour plus direction relative to the queried entity. */
export interface KnowledgeGraphNeighborEdge {
  id: string;
  predicate: string;
  /** True when the queried entity is the subject of the relation. */
  outbound: boolean;
  reviewStatus: KnowledgeGraphReviewStatus;
  other: KnowledgeGraphEntityView;
}

export interface KnowledgeGraphNeighborhood {
  entity: KnowledgeGraphEntityView | null;
  edges: KnowledgeGraphNeighborEdge[];
  /** True active degree from a count query — never the length of the capped page. */
  total: number;
}

/**
 * First paint of the interactive map. 150 keeps a hub readable while covering
 * nearly every real entity; the server clamps anything larger to 250.
 */
const NEIGHBORHOOD_DEFAULT_LIMIT = 150;
const NEIGHBORHOOD_MAX_LIMIT = 250;
/** One expansion click's worth of second-hop neighbours. */
export const NEIGHBORHOOD_EXPANSION_LIMIT = 50;

/**
 * The map's own data path, separate from the review list. The overview's
 * relation page is capped at 80 and ordered unreviewed-first so the owner sees
 * what needs attention; drawing the map from it showed a skewed subset for
 * high-degree entities. This query is ordered for stable rendering instead —
 * confirmed edges first, then recency — and reports the true active degree.
 *
 * Used for both the initial neighbourhood and the client-driven expansion,
 * which is why it takes any entity id rather than the page's selected one.
 */
export async function getKnowledgeGraphNeighborhood(
  db: Db,
  input: { entityId: string; limit?: number },
): Promise<KnowledgeGraphNeighborhood> {
  const agent = await getAgent(db);
  const entity = await agentEntity(db, input.entityId);
  if (!entity) return { entity: null, edges: [], total: 0 };
  const limit = Math.max(
    1,
    Math.min(input.limit ?? NEIGHBORHOOD_DEFAULT_LIMIT, NEIGHBORHOOD_MAX_LIMIT),
  );

  const subject = alias(knowledgeGraphEntities, 'neighbourhood_subject');
  const object = alias(knowledgeGraphEntities, 'neighbourhood_object');
  const incidentActive = and(
    eq(knowledgeGraphRelations.agentId, agent.id),
    ne(knowledgeGraphRelations.reviewStatus, 'rejected'),
    or(
      eq(knowledgeGraphRelations.subjectEntityId, entity.id),
      eq(knowledgeGraphRelations.objectEntityId, entity.id),
    ),
  );
  const [rows, [totalRow]] = await Promise.all([
    db
      .select({
        id: knowledgeGraphRelations.id,
        predicate: knowledgeGraphRelations.predicate,
        reviewStatus: knowledgeGraphRelations.reviewStatus,
        subjectId: knowledgeGraphRelations.subjectEntityId,
        objectId: knowledgeGraphRelations.objectEntityId,
        subjectLabel: displayLabel(subject),
        subjectKind: subject.kind,
        subjectCanonicalKey: subject.canonicalKey,
        objectLabel: displayLabel(object),
        objectKind: object.kind,
        objectCanonicalKey: object.canonicalKey,
      })
      .from(knowledgeGraphRelations)
      .innerJoin(subject, eq(knowledgeGraphRelations.subjectEntityId, subject.id))
      .innerJoin(object, eq(knowledgeGraphRelations.objectEntityId, object.id))
      .where(incidentActive)
      .orderBy(
        asc(sql`CASE ${knowledgeGraphRelations.reviewStatus} WHEN 'confirmed' THEN 0 ELSE 1 END`),
        desc(knowledgeGraphRelations.createdAt),
      )
      .limit(limit),
    db.select({ value: count() }).from(knowledgeGraphRelations).where(incidentActive),
  ]);
  const edges = rows.map((row) => {
    const outbound = row.subjectId === entity.id;
    return {
      id: row.id,
      predicate: row.predicate,
      outbound,
      reviewStatus: asReviewStatus(row.reviewStatus),
      other: outbound
        ? {
            id: row.objectId,
            label: row.objectLabel,
            kind: row.objectKind,
            canonicalKey: row.objectCanonicalKey,
          }
        : {
            id: row.subjectId,
            label: row.subjectLabel,
            kind: row.subjectKind,
            canonicalKey: row.subjectCanonicalKey,
          },
    };
  });
  return { entity, edges, total: Number(totalRow?.value ?? 0) };
}

/**
 * Type-ahead over every entity, replacing the old 200-row `<select>` payload.
 * The cap here bounds one dropdown's worth of results, not the reachable set:
 * anything can be found by narrowing the query, which is what the fixed list
 * could not do.
 */
export async function searchKnowledgeGraphEntities(
  db: Db,
  input: { query: string; excludeId?: string; kind?: string; limit?: number },
): Promise<KnowledgeGraphEntityView[]> {
  const agent = await getAgent(db);
  const query = cleanSearch(input.query);
  const excludeId = input.excludeId && UUID_RE.test(input.excludeId) ? input.excludeId : null;
  return db
    .select({
      id: knowledgeGraphEntities.id,
      label: displayLabel(knowledgeGraphEntities),
      kind: knowledgeGraphEntities.kind,
      canonicalKey: knowledgeGraphEntities.canonicalKey,
    })
    .from(knowledgeGraphEntities)
    .where(
      and(
        eq(knowledgeGraphEntities.agentId, agent.id),
        excludeId ? ne(knowledgeGraphEntities.id, excludeId) : undefined,
        input.kind ? eq(knowledgeGraphEntities.kind, input.kind) : undefined,
        query ? ilike(displayLabel(knowledgeGraphEntities), `%${query}%`) : undefined,
      ),
    )
    .orderBy(asc(sortLabel(knowledgeGraphEntities)))
    .limit(Math.min(input.limit ?? 20, 50));
}

/**
 * Advisory merge hints for one entity — never an automatic merge. Scoped to the
 * same kind and to a name-prefix relationship ("Anna" / "Anna Jónsdóttir"),
 * which is the same conservative rule `findDuplicateContactSuggestions` applies
 * to contacts. Candidates are bounded because the comparison is per-pair.
 */
export async function findDuplicateKnowledgeGraphEntities(
  db: Db,
  entity: KnowledgeGraphEntityView,
): Promise<KnowledgeGraphDuplicate[]> {
  const agent = await getAgent(db);
  const candidates = await db
    .select({
      id: knowledgeGraphEntities.id,
      label: displayLabel(knowledgeGraphEntities),
      kind: knowledgeGraphEntities.kind,
    })
    .from(knowledgeGraphEntities)
    .where(
      and(
        eq(knowledgeGraphEntities.agentId, agent.id),
        eq(knowledgeGraphEntities.kind, entity.kind),
        ne(knowledgeGraphEntities.id, entity.id),
      ),
    )
    .orderBy(asc(sortLabel(knowledgeGraphEntities)))
    .limit(500);
  const source = entity.label.toLocaleLowerCase();
  return candidates
    .filter((row) => namePrefixMatch(source, row.label.toLocaleLowerCase()))
    .slice(0, 5)
    .map((row) => ({
      targetId: row.id,
      label: row.label,
      kind: row.kind,
      reason: 'matching name',
    }));
}

async function agentEntity(db: Db, entityId: string): Promise<KnowledgeGraphEntityView | null> {
  if (!UUID_RE.test(entityId)) return null;
  const agent = await getAgent(db);
  const [entity] = await db
    .select({
      id: knowledgeGraphEntities.id,
      label: displayLabel(knowledgeGraphEntities),
      kind: knowledgeGraphEntities.kind,
      canonicalKey: knowledgeGraphEntities.canonicalKey,
    })
    .from(knowledgeGraphEntities)
    .where(
      and(eq(knowledgeGraphEntities.id, entityId), eq(knowledgeGraphEntities.agentId, agent.id)),
    )
    .limit(1);
  return entity ?? null;
}

export async function renameKnowledgeGraphEntity(
  db: Db,
  entityId: string,
  label: string,
): Promise<{ error?: string }> {
  const clean = label.replace(/\s+/g, ' ').trim().slice(0, 160);
  if (!clean) return { error: 'Enter a display name.' };
  const entity = await agentEntity(db, entityId);
  if (!entity) return { error: 'Knowledge item not found.' };
  await db
    .update(knowledgeGraphEntities)
    .set({ preferredLabel: clean, updatedAt: sql`now()` })
    .where(eq(knowledgeGraphEntities.id, entity.id));
  return {};
}

export async function mergeKnowledgeGraphEntities(
  db: Db,
  sourceId: string,
  targetId: string,
): Promise<{ error?: string }> {
  if (sourceId === targetId) return { error: 'Choose a different item to merge into.' };
  const [source, target] = await Promise.all([
    agentEntity(db, sourceId),
    agentEntity(db, targetId),
  ]);
  if (!source || !target) return { error: 'One of those knowledge items no longer exists.' };
  const agent = await getAgent(db);
  await mergeGraphEntities(db, agent.id, source.id, target.id);
  return {};
}

export async function reviewKnowledgeGraphRelation(
  db: Db,
  relationId: string,
  reviewStatus: 'confirmed' | 'rejected',
): Promise<void> {
  if (!UUID_RE.test(relationId)) return;
  const agent = await getAgent(db);
  await db
    .update(knowledgeGraphRelations)
    .set({ reviewStatus, reviewedAt: sql`now()` })
    .where(
      and(
        eq(knowledgeGraphRelations.id, relationId),
        eq(knowledgeGraphRelations.agentId, agent.id),
      ),
    );
}

/**
 * Re-extract the sources whose dates only a date-anchored prompt can resolve.
 * Unlike the nightly backfill this spends money — one metered model call per
 * source — so it is an explicit owner action rather than something that happens
 * on a schedule.
 */
export async function reextractRelativeDateSources(db: Db): Promise<number> {
  const agent = await getAgent(db);
  return requeueRelativeDateSources(db, agent.id);
}

/** Queue the next normal graph-sync attempt for every source the owner has chosen to retry. */
export async function retryQuarantinedKnowledgeGraphSources(db: Db): Promise<number> {
  const agent = await getAgent(db);
  return retryQuarantinedSources(db, agent.id);
}

export async function retypeKnowledgeGraphEntity(
  db: Db,
  entityId: string,
  kind: string,
): Promise<{ error?: string }> {
  const next = asGraphEntityKind(kind);
  if (!next) return { error: 'Choose a valid type.' };
  const agent = await getAgent(db);
  return retypeGraphEntity(db, agent.id, entityId, next);
}

export async function addOwnerKnowledgeGraphFact(
  db: Db,
  router: EmbeddingPort,
  input: {
    subjectLabel: string;
    subjectKind: string;
    subjectId?: string;
    predicate: string;
    objectLabel: string;
    objectKind: string;
    objectId?: string;
    note: string;
  },
): Promise<{ error?: string }> {
  // The domain owns the kind list; re-declaring it here let the two drift.
  const isKind = (value: string): value is GraphEntityKind =>
    (GRAPH_ENTITY_KINDS as readonly string[]).includes(value);
  // An endpoint with an id gets its kind from the entity itself; the form's
  // kind field is only meaningful for a free-typed (new) entity.
  if (!input.subjectId && !isKind(input.subjectKind)) {
    return { error: 'Choose a valid source type.' };
  }
  if (!input.objectId && !isKind(input.objectKind)) {
    return { error: 'Choose a valid target type.' };
  }
  return createOwnerKnowledgeGraphFact(
    { db, router },
    {
      subject: {
        label: input.subjectLabel,
        kind: isKind(input.subjectKind) ? input.subjectKind : 'topic',
        id: input.subjectId,
      },
      predicate: input.predicate,
      object: {
        label: input.objectLabel,
        kind: isKind(input.objectKind) ? input.objectKind : 'topic',
        id: input.objectId,
      },
      note: input.note,
    },
  );
}
