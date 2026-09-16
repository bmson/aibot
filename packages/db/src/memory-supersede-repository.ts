import {
  MAX_SUPERSEDE_CANDIDATES,
  type MemorySupersedeRepository,
  SUPERSEDE_SIMILARITY_FLOOR,
} from '@assistant/persistence';
import { and, asc, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { memories } from './schema.js';

/** The precedence fields, projected the same way everywhere in this adapter. */
const FACT_COLUMNS = {
  id: memories.id,
  content: memories.content,
  confidence: memories.confidence,
  ownerConfirmed: memories.ownerConfirmed,
  createdAt: memories.createdAt,
} as const;

export function createPostgresMemorySupersedeRepository(db: Db): MemorySupersedeRepository {
  return {
    kind: 'memory-supersede-repository',

    async writtenFact(input) {
      const [row] = await db
        .select({
          ...FACT_COLUMNS,
          subjectContactId: memories.subjectContactId,
          embedding: memories.embedding,
        })
        .from(memories)
        .where(and(eq(memories.id, input.id), eq(memories.agentId, input.agentId)))
        .limit(1);
      return row ?? null;
    },

    async candidates(input) {
      const vector = JSON.stringify(input.embedding);
      return db
        .select({
          ...FACT_COLUMNS,
          similarity: sql<number>`1 - (${memories.embedding} <=> ${vector}::vector)`,
        })
        .from(memories)
        .where(
          and(
            eq(memories.agentId, input.agentId),
            eq(memories.category, 'knowledge'),
            ne(memories.id, input.newFactId),
            isNotNull(memories.embedding),
            // Already retired or already expired is already out of recall.
            isNull(memories.supersededById),
            or(isNull(memories.expiresAt), gt(memories.expiresAt, sql`now()`)),
            // A quarantined fact answers nothing, so retiring it would change
            // nothing the owner can observe — and would quietly resolve a
            // review they have not done yet.
            eq(memories.quarantined, false),
            // Two facts about different people cannot contradict each other.
            // This is the precision lever that keeps the check cheap; "about
            // no one" is its own bucket rather than a wildcard.
            input.subjectContactId === null
              ? isNull(memories.subjectContactId)
              : eq(memories.subjectContactId, input.subjectContactId),
            sql`1 - (${memories.embedding} <=> ${vector}::vector) >= ${SUPERSEDE_SIMILARITY_FLOOR}`,
          ),
        )
        .orderBy(sql`${memories.embedding} <=> ${vector}::vector`, asc(memories.id))
        .limit(MAX_SUPERSEDE_CANDIDATES);
    },

    async retire(input) {
      const ids = [...new Set(input.ids)].filter((id) => id !== input.replacementId);
      if (ids.length === 0) return [];
      const rows = await db
        .update(memories)
        .set({ expiresAt: sql`now()`, supersededById: input.replacementId })
        .where(
          and(
            eq(memories.agentId, input.agentId),
            inArray(memories.id, ids),
            // Re-checked here, not merely in the read above: a concurrent save
            // may have retired the same fact in between, and the first
            // replacement's provenance is the one that should stand.
            isNull(memories.supersededById),
          ),
        )
        .returning({ id: memories.id });
      return rows.map((row) => row.id);
    },
  };
}
