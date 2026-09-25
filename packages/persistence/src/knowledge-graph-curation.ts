import type { KnowledgeWorkspaceEntity } from './knowledge-workspace.js';

export interface KnowledgeGraphCurationEntity {
  id: string;
  kind: string;
  label: string;
  canonicalKey: string;
  contactId: string | null;
}

/**
 * Owner curation of the derived knowledge graph. Every write is owner-scoped
 * and atomic; merges re-point relations and aliases so later extractions land
 * on the surviving entity.
 */
export interface KnowledgeGraphCurationRepository {
  readonly kind: 'knowledge-graph-curation-repository';
  entity(agentId: string, entityId: string): Promise<KnowledgeGraphCurationEntity | null>;
  /** Returns false when the entity no longer exists for this owner. */
  rename(agentId: string, entityId: string, preferredLabel: string): Promise<boolean>;
  /**
   * Re-key an entity whose identity is still `fromKey`, recording that key as
   * an alias. `conflict` when another entity already holds `canonicalKey`;
   * `changed` when the entity's identity moved since it was read.
   */
  retype(
    agentId: string,
    input: {
      entityId: string;
      fromKey: string;
      kind: string;
      canonicalKey: string;
      contactId: string | null;
    },
  ): Promise<'updated' | 'missing' | 'changed' | 'conflict'>;
  /**
   * Fold `sourceId` into `targetId`: re-point its relations and aliases, alias
   * its canonical key to the target, delete it, and drop the self-loops and
   * duplicate edges the merge created. False when either entity is missing.
   */
  merge(agentId: string, sourceId: string, targetId: string): Promise<boolean>;
  /** Delete owner entities that no relation references, with their aliases. */
  removeOrphanedEntities(agentId: string): Promise<number>;
  /** Make every failed or quarantined owner graph source due for the next sync. */
  retryBlockedSources(agentId: string): Promise<number>;
  /**
   * Make ready sources due again when their text has relative date wording
   * but no canonical date entity was extracted from them.
   */
  requeueRelativeDateSources(agentId: string): Promise<number>;
  searchEntities(
    agentId: string,
    input: { query: string; excludeId?: string; kind?: string; limit: number },
  ): Promise<KnowledgeWorkspaceEntity[]>;
}
