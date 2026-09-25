import {
  GRAPH_ENTITY_KINDS,
  type GraphEntityKind,
  retypeGraphEntityWithRepository,
} from '@assistant/core/memory/knowledge-graph';
import type { KnowledgeGraphCurationRepository } from '@assistant/persistence';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * SQL-free owner curation of the knowledge graph, with the same validation and
 * messages as the PostgreSQL workspace actions.
 */
export function knowledgeGraphCurationCommands(
  repository: KnowledgeGraphCurationRepository,
  agentId: string,
) {
  return {
    async rename(entityId: string, label: string): Promise<{ error?: string }> {
      const clean = label.replace(/\s+/g, ' ').trim().slice(0, 160);
      if (!clean) return { error: 'Enter a display name.' };
      if (!UUID_RE.test(entityId) || !(await repository.rename(agentId, entityId, clean)))
        return { error: 'Knowledge item not found.' };
      return {};
    },
    async retype(entityId: string, kind: string): Promise<{ error?: string }> {
      if (!(GRAPH_ENTITY_KINDS as readonly string[]).includes(kind))
        return { error: 'Choose a valid type.' };
      if (!UUID_RE.test(entityId)) return { error: 'Knowledge item not found.' };
      return retypeGraphEntityWithRepository(
        repository,
        agentId,
        entityId,
        kind as GraphEntityKind,
      );
    },
    async merge(sourceId: string, targetId: string): Promise<{ error?: string }> {
      if (sourceId === targetId) return { error: 'Choose a different item to merge into.' };
      if (
        !UUID_RE.test(sourceId) ||
        !UUID_RE.test(targetId) ||
        !(await repository.merge(agentId, sourceId, targetId))
      )
        return { error: 'One of those knowledge items no longer exists.' };
      return {};
    },
    removeOrphanedEntities: () => repository.removeOrphanedEntities(agentId),
    retryBlockedSources: () => repository.retryBlockedSources(agentId),
    /** One metered model call per source, so it stays an explicit owner action. */
    requeueRelativeDateSources: () => repository.requeueRelativeDateSources(agentId),
    /** Type-ahead over every entity; the cap bounds one dropdown, not the reachable set. */
    searchEntities(input: { query: string; excludeId?: string; kind?: string; limit?: number }) {
      return repository.searchEntities(agentId, {
        query: input.query.trim().slice(0, 120),
        excludeId: input.excludeId && UUID_RE.test(input.excludeId) ? input.excludeId : undefined,
        kind: input.kind || undefined,
        limit: Math.min(input.limit ?? 20, 50),
      });
    },
  };
}

/**
 * A graph correction never mutates evidence in place. It creates a replacement
 * owner-backed fact first, then retires the edge the owner corrected.
 */
export async function correctKnowledgeGraphRelationWith<Input, Result extends { error?: string }>(
  ports: {
    relationExists(relationId: string): Promise<boolean>;
    addFact(input: Input): Promise<Result>;
    reject(relationId: string): Promise<boolean>;
  },
  relationId: string,
  input: Input,
): Promise<Result | { error: string }> {
  if (!UUID_RE.test(relationId) || !(await ports.relationExists(relationId)))
    return { error: 'That relationship no longer exists.' };
  const result = await ports.addFact(input);
  if (result.error) return result;
  await ports.reject(relationId);
  return result;
}
