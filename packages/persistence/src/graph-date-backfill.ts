/** A date entity a relation still cites, with the span of its citing memories. */
export interface CitedDateEntity {
  id: string;
  label: string;
  canonicalKey: string;
  /** Creation time of the earliest citing memory. */
  anchor: Date;
  /** Creation time of the latest citing memory. */
  lastAnchor: Date;
}

/**
 * The free `memory.graph_date_backfill` job's graph access. Canonicalizing a
 * label stays in core; every write is owner-scoped and atomic.
 */
export interface GraphDateBackfillRepository {
  readonly kind: 'graph-date-backfill-repository';
  dateSettings(agentId: string): Promise<{ timeZone: string; locale: string }>;
  citedDateEntities(agentId: string): Promise<CitedDateEntity[]>;
  /** Another entity that already holds `canonicalKey`, if any. */
  canonicalHolder(agentId: string, canonicalKey: string, excludeId: string): Promise<string | null>;
  /**
   * Give a date entity its canonical key and label without aliasing the old
   * wording. `conflict` when another entity holds the key; `changed` when the
   * entity's key moved since it was read.
   */
  recanonicalize(
    agentId: string,
    input: { entityId: string; fromKey: string; canonicalKey: string; label: string },
  ): Promise<'updated' | 'missing' | 'changed' | 'conflict'>;
  /** Fold `sourceId` into `targetId`, as owner curation does. */
  merge(agentId: string, sourceId: string, targetId: string): Promise<boolean>;
  removeOrphanedEntities(agentId: string): Promise<number>;
  /** Sources only a paid, anchored re-extraction could date. */
  countRelativeDateSources(agentId: string): Promise<number>;
}
