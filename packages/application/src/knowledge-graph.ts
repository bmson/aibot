import { getAgent } from '@assistant/core/chat';
import {
  createOwnerKnowledgeGraphFact,
  GRAPH_ENTITY_KINDS,
  type GraphEntityKind,
  retryQuarantinedKnowledgeGraphSources as retryQuarantinedSources,
} from '@assistant/core/memory/knowledge-graph';
import {
  type Db,
  knowledgeGraphEntities,
  knowledgeGraphEntityAliases,
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

/** Owner-facing, bounded graph inspection. It reads only source-backed edges. */
export async function getKnowledgeGraphOverview(
  db: Db,
  input: { query?: string; entityId?: string; page?: number; pageSize?: number } = {},
): Promise<KnowledgeGraphOverview> {
  const agent = await getAgent(db);
  const query = cleanSearch(input.query ?? '');
  const pageSize = input.pageSize ?? ENTITY_PAGE_SIZE;
  const entityCondition = and(
    eq(knowledgeGraphEntities.agentId, agent.id),
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
  const requestedId = input.entityId && UUID_RE.test(input.entityId) ? input.entityId : null;
  const selected =
    (requestedId
      ? (entities.find((entity) => entity.id === requestedId) ??
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
      pendingSources: Number(pendingSources?.value ?? 0),
      quarantinedSources: Number(quarantinedSources?.value ?? 0),
      entities,
      matchingEntities,
      entityPage,
      entityPages,
      selected: null,
      relations: [],
      selectedRelationTotal: 0,
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
  const [relationRows, [selectedRelationRow], duplicates] = await Promise.all([
    db
      .select({
        id: knowledgeGraphRelations.id,
        predicate: knowledgeGraphRelations.predicate,
        confidence: knowledgeGraphRelations.confidence,
        reviewStatus: knowledgeGraphRelations.reviewStatus,
        reviewedAt: knowledgeGraphRelations.reviewedAt,
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
    pendingSources: Number(pendingSources?.value ?? 0),
    quarantinedSources: Number(quarantinedSources?.value ?? 0),
    entities,
    matchingEntities,
    entityPage,
    entityPages,
    selected,
    relations,
    selectedRelationTotal: Number(selectedRelationRow?.value ?? 0),
    duplicates,
  };
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
  await db.transaction(async (tx) => {
    await tx
      .update(knowledgeGraphRelations)
      .set({ subjectEntityId: target.id })
      .where(eq(knowledgeGraphRelations.subjectEntityId, source.id));
    await tx
      .update(knowledgeGraphRelations)
      .set({ objectEntityId: target.id })
      .where(eq(knowledgeGraphRelations.objectEntityId, source.id));
    await tx
      .insert(knowledgeGraphEntityAliases)
      .values({ agentId: agent.id, canonicalKey: source.canonicalKey, entityId: target.id })
      .onConflictDoUpdate({
        target: [knowledgeGraphEntityAliases.agentId, knowledgeGraphEntityAliases.canonicalKey],
        set: { entityId: target.id },
      });
    await tx
      .update(knowledgeGraphEntityAliases)
      .set({ entityId: target.id })
      .where(eq(knowledgeGraphEntityAliases.entityId, source.id));
    await tx.delete(knowledgeGraphEntities).where(eq(knowledgeGraphEntities.id, source.id));
  });
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

/** Queue the next normal graph-sync attempt for every source the owner has chosen to retry. */
export async function retryQuarantinedKnowledgeGraphSources(db: Db): Promise<number> {
  const agent = await getAgent(db);
  return retryQuarantinedSources(db, agent.id);
}

export async function addOwnerKnowledgeGraphFact(
  db: Db,
  router: EmbeddingPort,
  input: {
    subjectLabel: string;
    subjectKind: string;
    predicate: string;
    objectLabel: string;
    objectKind: string;
    note: string;
  },
): Promise<{ error?: string }> {
  // The domain owns the kind list; re-declaring it here let the two drift.
  const isKind = (value: string): value is GraphEntityKind =>
    (GRAPH_ENTITY_KINDS as readonly string[]).includes(value);
  if (!isKind(input.subjectKind)) return { error: 'Choose a valid source type.' };
  if (!isKind(input.objectKind)) return { error: 'Choose a valid target type.' };
  return createOwnerKnowledgeGraphFact(
    { db, router },
    {
      subject: { label: input.subjectLabel, kind: input.subjectKind },
      predicate: input.predicate,
      object: { label: input.objectLabel, kind: input.objectKind },
      note: input.note,
    },
  );
}
