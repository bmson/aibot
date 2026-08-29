import { getAgent } from '@assistant/core/chat';
import { getMemoryHealth, type MemoryHealth } from '@assistant/core/memory/health';
import { removeOrphanedKnowledgeGraphEntities } from '@assistant/core/memory/knowledge-graph';
import {
  type Db,
  knowledgeGraphEntities,
  knowledgeGraphRelations,
  knowledgeGraphSources,
  memories,
} from '@assistant/db';
import { and, count, desc, eq, ilike, inArray, isNotNull, lte, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  activeKnowledgeGraphWhere,
  getKnowledgeGraphOverview,
  type KnowledgeGraphReviewStatus,
} from './knowledge-graph.js';
import { correctMemory, type EmbeddingPort, forgetMemory } from './profile/commands.js';

export type KnowledgeCleanupKind =
  | 'quarantined'
  | 'expired'
  | 'superseded'
  | 'unreviewed_connection'
  | 'rejected_connection'
  | 'projection_orphan'
  | 'projection_failed';

export interface KnowledgeCleanupFinding {
  id: string;
  kind: KnowledgeCleanupKind;
  title: string;
  detail: string;
  memoryId: string | null;
  relationId: string | null;
  count: number;
}

export interface KnowledgeWorkspaceOverview {
  memory: MemoryHealth;
  graph: {
    activeEntities: number;
    activeRelations: number;
    orphanedEntities: number;
    pendingSources: number;
    failedSources: number;
  };
  cleanupCount: number;
}

export interface KnowledgeMapNode {
  id: string;
  label: string;
  kind: string;
  component: number;
  degree: number;
}

export interface KnowledgeMapEdge {
  id: string;
  subjectId: string;
  objectId: string;
  predicate: string;
  reviewStatus: KnowledgeGraphReviewStatus;
  sourceMemoryId: string;
  sourceContent: string;
}

export interface KnowledgeMapComponent {
  id: number;
  nodes: number;
  edges: number;
  label: string;
}

export interface KnowledgeMapSnapshot {
  nodes: KnowledgeMapNode[];
  edges: KnowledgeMapEdge[];
  components: KnowledgeMapComponent[];
  totalEdges: number;
  truncated: boolean;
  filters: {
    query: string;
    kind: string;
    predicates: string[];
    review: 'all' | KnowledgeGraphReviewStatus;
  };
}

export interface KnowledgeSourceImpact {
  memoryId: string;
  content: string;
  connectionCount: number;
  orphanedItems: Array<{ id: string; label: string }>;
}

const MAP_NODE_LIMIT = 200;
const MAP_EDGE_FETCH_LIMIT = 500;

function asRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && 'rows' in result) {
    return ((result as { rows?: T[] }).rows ?? []) as T[];
  }
  return [];
}

export async function getKnowledgeCleanupFindings(db: Db): Promise<KnowledgeCleanupFinding[]> {
  const agent = await getAgent(db);
  const [memoryRows, rejectedRows, sourceRows, orphanRows] = await Promise.all([
    db
      .select({
        id: memories.id,
        content: memories.content,
        quarantined: memories.quarantined,
        expiresAt: memories.expiresAt,
        supersededById: memories.supersededById,
      })
      .from(memories)
      .where(
        and(
          eq(memories.agentId, agent.id),
          eq(memories.category, 'knowledge'),
          or(
            eq(memories.quarantined, true),
            and(isNotNull(memories.expiresAt), lte(memories.expiresAt, sql`now()`)),
            isNotNull(memories.supersededById),
          ),
        ),
      )
      .orderBy(desc(memories.createdAt))
      .limit(100),
    db
      .select({
        id: knowledgeGraphRelations.id,
        memoryId: memories.id,
        content: memories.content,
        reviewStatus: knowledgeGraphRelations.reviewStatus,
      })
      .from(knowledgeGraphRelations)
      .innerJoin(memories, eq(memories.id, knowledgeGraphRelations.sourceMemoryId))
      .where(
        and(
          eq(knowledgeGraphRelations.agentId, agent.id),
          inArray(knowledgeGraphRelations.reviewStatus, ['unreviewed', 'rejected']),
        ),
      )
      .limit(50),
    db
      .select({ memoryId: knowledgeGraphSources.memoryId, status: knowledgeGraphSources.status })
      .from(knowledgeGraphSources)
      .innerJoin(memories, eq(memories.id, knowledgeGraphSources.memoryId))
      .where(
        and(
          eq(memories.agentId, agent.id),
          inArray(knowledgeGraphSources.status, ['failed', 'quarantined']),
        ),
      )
      .limit(50),
    db.execute(sql`
      SELECT count(*)::int AS count
      FROM knowledge_graph_entities AS entity
      WHERE entity.agent_id = ${agent.id}
        AND NOT EXISTS (
          SELECT 1 FROM knowledge_graph_relations AS relation
          WHERE relation.subject_entity_id = entity.id OR relation.object_entity_id = entity.id
        )
    `),
  ]);
  const findings: KnowledgeCleanupFinding[] = memoryRows.map((memory) => {
    const kind: KnowledgeCleanupKind = memory.quarantined
      ? 'quarantined'
      : memory.supersededById
        ? 'superseded'
        : 'expired';
    return {
      id: `${kind}:${memory.id}`,
      kind,
      title:
        kind === 'quarantined'
          ? 'Review an unverified memory'
          : kind === 'superseded'
            ? 'Remove an older version'
            : 'Review expired knowledge',
      detail: memory.content,
      memoryId: memory.id,
      relationId: null,
      count: 1,
    };
  });
  for (const relation of rejectedRows) {
    const unreviewed = relation.reviewStatus === 'unreviewed';
    findings.push({
      id: `${unreviewed ? 'unreviewed_connection' : 'rejected_connection'}:${relation.id}`,
      kind: unreviewed ? 'unreviewed_connection' : 'rejected_connection',
      title: unreviewed ? 'Review a new connection' : 'Retire a rejected connection source',
      detail: relation.content,
      memoryId: relation.memoryId,
      relationId: relation.id,
      count: 1,
    });
  }
  for (const source of sourceRows) {
    findings.push({
      id: `projection_failed:${source.memoryId}`,
      kind: 'projection_failed',
      title: 'Graph processing needs attention',
      detail:
        source.status === 'quarantined'
          ? 'Automatic retries were exhausted.'
          : 'The latest graph extraction failed.',
      memoryId: source.memoryId,
      relationId: null,
      count: 1,
    });
  }
  const orphanCount = Number(asRows<{ count: number }>(orphanRows)[0]?.count ?? 0);
  if (orphanCount > 0) {
    findings.unshift({
      id: 'projection_orphan:all',
      kind: 'projection_orphan',
      title: 'Remove disconnected graph items',
      detail:
        'These derived items have no source-backed connections and are never used for recall.',
      memoryId: null,
      relationId: null,
      count: orphanCount,
    });
  }
  return findings;
}

export async function getKnowledgeWorkspaceOverview(db: Db): Promise<KnowledgeWorkspaceOverview> {
  const agent = await getAgent(db);
  const [memory, graph, findings, failedRows, orphanRows] = await Promise.all([
    getMemoryHealth(db, agent.id),
    getKnowledgeGraphOverview(db, { pageSize: 1 }),
    getKnowledgeCleanupFindings(db),
    db
      .select({ value: count() })
      .from(knowledgeGraphSources)
      .innerJoin(memories, eq(memories.id, knowledgeGraphSources.memoryId))
      .where(
        and(
          eq(memories.agentId, agent.id),
          inArray(knowledgeGraphSources.status, ['failed', 'quarantined']),
        ),
      ),
    db.execute(sql`
      SELECT count(*)::int AS count
      FROM knowledge_graph_entities AS entity
      WHERE entity.agent_id = ${agent.id}
        AND NOT EXISTS (
          SELECT 1 FROM knowledge_graph_relations AS relation
          WHERE relation.subject_entity_id = entity.id OR relation.object_entity_id = entity.id
        )
    `),
  ]);
  return {
    memory,
    graph: {
      activeEntities: graph.totalEntities,
      activeRelations: graph.totalRelations,
      orphanedEntities: Number(asRows<{ count: number }>(orphanRows)[0]?.count ?? 0),
      pendingSources: graph.pendingSources,
      failedSources: Number(failedRows[0]?.value ?? 0),
    },
    cleanupCount: findings.length,
  };
}

export async function getKnowledgeMapSnapshot(
  db: Db,
  input: {
    query?: string;
    kind?: string;
    predicates?: string[];
    review?: 'all' | KnowledgeGraphReviewStatus;
  } = {},
): Promise<KnowledgeMapSnapshot> {
  const agent = await getAgent(db);
  const subject = alias(knowledgeGraphEntities, 'map_subject');
  const object = alias(knowledgeGraphEntities, 'map_object');
  const query = (input.query ?? '').trim().slice(0, 120);
  const kind = input.kind ?? '';
  const predicates = (input.predicates ?? []).filter(Boolean).slice(0, 20);
  const review = input.review ?? 'all';
  const filters = and(
    activeKnowledgeGraphWhere(agent.id),
    query ? or(ilike(subject.label, `%${query}%`), ilike(object.label, `%${query}%`)) : undefined,
    kind ? or(eq(subject.kind, kind), eq(object.kind, kind)) : undefined,
    predicates.length > 0 ? inArray(knowledgeGraphRelations.predicate, predicates) : undefined,
    review !== 'all' ? eq(knowledgeGraphRelations.reviewStatus, review) : undefined,
  );
  const [rows, [totalRow]] = await Promise.all([
    db
      .select({
        id: knowledgeGraphRelations.id,
        predicate: knowledgeGraphRelations.predicate,
        reviewStatus: knowledgeGraphRelations.reviewStatus,
        subjectId: subject.id,
        subjectLabel: subject.label,
        subjectKind: subject.kind,
        objectId: object.id,
        objectLabel: object.label,
        objectKind: object.kind,
        sourceMemoryId: memories.id,
        sourceContent: memories.content,
      })
      .from(knowledgeGraphRelations)
      .innerJoin(subject, eq(subject.id, knowledgeGraphRelations.subjectEntityId))
      .innerJoin(object, eq(object.id, knowledgeGraphRelations.objectEntityId))
      .innerJoin(memories, eq(memories.id, knowledgeGraphRelations.sourceMemoryId))
      .innerJoin(knowledgeGraphSources, eq(knowledgeGraphSources.memoryId, memories.id))
      .where(filters)
      .orderBy(desc(knowledgeGraphRelations.createdAt))
      .limit(MAP_EDGE_FETCH_LIMIT),
    db
      .select({ value: count() })
      .from(knowledgeGraphRelations)
      .innerJoin(subject, eq(subject.id, knowledgeGraphRelations.subjectEntityId))
      .innerJoin(object, eq(object.id, knowledgeGraphRelations.objectEntityId))
      .innerJoin(memories, eq(memories.id, knowledgeGraphRelations.sourceMemoryId))
      .innerJoin(knowledgeGraphSources, eq(knowledgeGraphSources.memoryId, memories.id))
      .where(filters),
  ]);
  const nodeData = new Map<string, { id: string; label: string; kind: string; degree: number }>();
  const edges: KnowledgeMapEdge[] = [];
  for (const row of rows) {
    const newIds = [row.subjectId, row.objectId].filter((id) => !nodeData.has(id));
    if (nodeData.size + newIds.length > MAP_NODE_LIMIT) continue;
    nodeData.set(row.subjectId, {
      id: row.subjectId,
      label: row.subjectLabel,
      kind: row.subjectKind,
      degree: (nodeData.get(row.subjectId)?.degree ?? 0) + 1,
    });
    nodeData.set(row.objectId, {
      id: row.objectId,
      label: row.objectLabel,
      kind: row.objectKind,
      degree: (nodeData.get(row.objectId)?.degree ?? 0) + 1,
    });
    edges.push({
      id: row.id,
      subjectId: row.subjectId,
      objectId: row.objectId,
      predicate: row.predicate,
      reviewStatus: row.reviewStatus as KnowledgeGraphReviewStatus,
      sourceMemoryId: row.sourceMemoryId,
      sourceContent: row.sourceContent,
    });
  }
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    adjacency.set(edge.subjectId, (adjacency.get(edge.subjectId) ?? new Set()).add(edge.objectId));
    adjacency.set(edge.objectId, (adjacency.get(edge.objectId) ?? new Set()).add(edge.subjectId));
  }
  const componentFor = new Map<string, number>();
  let componentId = 0;
  for (const id of nodeData.keys()) {
    if (componentFor.has(id)) continue;
    const queue = [id];
    componentFor.set(id, componentId);
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) break;
      for (const next of adjacency.get(current) ?? []) {
        if (componentFor.has(next)) continue;
        componentFor.set(next, componentId);
        queue.push(next);
      }
    }
    componentId += 1;
  }
  const nodes = [...nodeData.values()].map((node) => ({
    ...node,
    component: componentFor.get(node.id) ?? 0,
  }));
  const components = Array.from({ length: componentId }, (_, id) => {
    const members = nodes.filter((node) => node.component === id);
    const componentEdges = edges.filter(
      (edge) => componentFor.get(edge.subjectId) === id && componentFor.get(edge.objectId) === id,
    );
    return {
      id,
      nodes: members.length,
      edges: componentEdges.length,
      label: [...members].sort((a, b) => b.degree - a.degree)[0]?.label ?? 'Connected knowledge',
    };
  }).sort((a, b) => b.nodes - a.nodes);
  const totalEdges = Number(totalRow?.value ?? 0);
  return {
    nodes,
    edges,
    components,
    totalEdges,
    truncated: totalEdges > edges.length,
    filters: { query, kind, predicates, review },
  };
}

export async function getKnowledgeSourceImpact(
  db: Db,
  memoryId: string,
): Promise<KnowledgeSourceImpact | null> {
  const agent = await getAgent(db);
  const [memory] = await db
    .select({ id: memories.id, content: memories.content })
    .from(memories)
    .where(and(eq(memories.id, memoryId), eq(memories.agentId, agent.id)))
    .limit(1);
  if (!memory) return null;
  const rows = asRows<{ id: string; label: string }>(
    await db.execute(sql`
    WITH endpoints AS (
      SELECT subject_entity_id AS id FROM knowledge_graph_relations WHERE source_memory_id = ${memoryId}
      UNION
      SELECT object_entity_id AS id FROM knowledge_graph_relations WHERE source_memory_id = ${memoryId}
    )
    SELECT entity.id, coalesce(entity.preferred_label, entity.label) AS label
    FROM endpoints
    INNER JOIN knowledge_graph_entities AS entity ON entity.id = endpoints.id
    WHERE NOT EXISTS (
      SELECT 1 FROM knowledge_graph_relations AS other
      WHERE other.source_memory_id <> ${memoryId}
        AND (other.subject_entity_id = entity.id OR other.object_entity_id = entity.id)
    )
  `),
  );
  const [relationCount] = await db
    .select({ value: count() })
    .from(knowledgeGraphRelations)
    .where(eq(knowledgeGraphRelations.sourceMemoryId, memoryId));
  return {
    memoryId,
    content: memory.content,
    connectionCount: Number(relationCount?.value ?? 0),
    orphanedItems: rows,
  };
}

export async function correctKnowledgeSource(
  db: Db,
  router: EmbeddingPort,
  memoryId: string,
  content: string,
): Promise<{ error?: string }> {
  return correctMemory(db, router, memoryId, content);
}

export async function forgetKnowledgeSource(db: Db, memoryId: string): Promise<void> {
  await forgetMemory(db, memoryId);
}

export async function cleanKnowledgeProjectionOrphans(db: Db): Promise<number> {
  const agent = await getAgent(db);
  return removeOrphanedKnowledgeGraphEntities(db, agent.id);
}
