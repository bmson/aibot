import type { GraphDateBackfillRepository } from '@assistant/persistence';
import { withSpan } from '../otel.js';
import { canonicalizeDateLabel } from './date-labels.js';
import type { GraphDateBackfillResult } from './knowledge-graph.js';

/**
 * `backfillKnowledgeGraphDates` over a portable repository: the same free,
 * idempotent canonicalization, decided in the same order. A node whose wording
 * resolves to different days from either end of its citing window is left for
 * the anchored re-extraction, and a node whose date another node already holds
 * is folded into it.
 */
export async function backfillGraphDates(
  store: GraphDateBackfillRepository,
  agentId: string,
): Promise<GraphDateBackfillResult> {
  return withSpan('memory.graph_date_backfill', { agentId }, async () => {
    const { timeZone, locale } = await store.dateSettings(agentId);
    const result: GraphDateBackfillResult = {
      scanned: 0,
      canonicalized: 0,
      merged: 0,
      unresolved: 0,
    };
    for (const row of await store.citedDateEntities(agentId)) {
      result.scanned += 1;
      const canonical = canonicalizeDateLabel(row.label, row.anchor, timeZone, locale);
      if (!canonical) {
        result.unresolved += 1;
        continue;
      }
      const fromLatest = canonicalizeDateLabel(row.label, row.lastAnchor, timeZone, locale);
      if (!fromLatest || fromLatest.key !== canonical.key) {
        result.unresolved += 1;
        continue;
      }
      const canonicalKey = `date:${canonical.key}`;
      if (canonicalKey === row.canonicalKey && canonical.label === row.label) continue;

      const holder = await store.canonicalHolder(agentId, canonicalKey, row.id);
      if (holder) {
        // Another spelling of this same date already has the canonical key.
        if (await store.merge(agentId, row.id, holder)) result.merged += 1;
        continue;
      }
      const outcome = await store.recanonicalize(agentId, {
        entityId: row.id,
        fromKey: row.canonicalKey,
        canonicalKey,
        label: canonical.label,
      });
      if (outcome === 'updated') result.canonicalized += 1;
      else if (outcome === 'conflict') {
        // A holder appeared since it was looked up; fold into it instead.
        const late = await store.canonicalHolder(agentId, canonicalKey, row.id);
        if (late && (await store.merge(agentId, row.id, late))) result.merged += 1;
      }
    }
    await store.removeOrphanedEntities(agentId);
    return result;
  });
}
