import { type Db, memories } from '@assistant/db';
import { and, eq, sql } from 'drizzle-orm';

export interface MemoryHealth {
  /** Active, usable knowledge available to recall and profile compilation. */
  totalUsable: number;
  /** Usable knowledge that has not passed through memory consolidation yet. */
  notYetOrganized: number;
  /** Unexpired knowledge held back until the owner reviews its source. */
  awaitingReview: number;
  /** Usable knowledge the owner explicitly confirmed or corrected. */
  ownerConfirmed: number;
  /** Most recent consolidation timestamp across active usable knowledge. */
  lastOrganizedAt: Date | null;
}

/**
 * A small, factual health summary for the Memory UI. These labels intentionally
 * describe lifecycle state rather than claiming an unmeasurable quality score.
 */
export async function getMemoryHealth(db: Db, agentId: string): Promise<MemoryHealth> {
  // One pass over this agent's knowledge rows. All four lifecycle counts and the
  // last-organized timestamp are conditional aggregates over the same scan, so
  // the sidebar badge (rendered on every page) costs a single round trip instead
  // of five. `unexpired` and `usable` are reused across the FILTER clauses.
  const unexpired = sql`(${memories.expiresAt} IS NULL OR ${memories.expiresAt} > now())`;
  const usable = sql`${unexpired} AND ${memories.quarantined} = false`;

  const [row] = await db
    .select({
      totalUsable: sql<number>`count(*) FILTER (WHERE ${usable})`,
      notYetOrganized: sql<number>`count(*) FILTER (WHERE ${usable} AND ${memories.lastConsolidatedAt} IS NULL)`,
      awaitingReview: sql<number>`count(*) FILTER (WHERE ${unexpired} AND ${memories.quarantined} = true)`,
      ownerConfirmed: sql<number>`count(*) FILTER (WHERE ${usable} AND ${memories.ownerConfirmed} = true)`,
      lastOrganizedAt: sql<Date | null>`max(${memories.lastConsolidatedAt}) FILTER (WHERE ${usable})`,
    })
    .from(memories)
    .where(and(eq(memories.agentId, agentId), eq(memories.category, 'knowledge')));

  return {
    totalUsable: Number(row?.totalUsable ?? 0),
    notYetOrganized: Number(row?.notYetOrganized ?? 0),
    awaitingReview: Number(row?.awaitingReview ?? 0),
    ownerConfirmed: Number(row?.ownerConfirmed ?? 0),
    lastOrganizedAt: row?.lastOrganizedAt ? new Date(row.lastOrganizedAt) : null,
  };
}
