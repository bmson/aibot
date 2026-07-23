import { type Db, memories } from '@assistant/db';
import { and, count, eq, gt, isNull, max, or, sql } from 'drizzle-orm';

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
  const unexpired = or(isNull(memories.expiresAt), gt(memories.expiresAt, sql`now()`));
  const usable = and(
    eq(memories.agentId, agentId),
    eq(memories.category, 'knowledge'),
    eq(memories.quarantined, false),
    unexpired,
  );
  const review = and(
    eq(memories.agentId, agentId),
    eq(memories.category, 'knowledge'),
    eq(memories.quarantined, true),
    unexpired,
  );

  const [[total], [unorganized], [awaiting], [confirmed], [lastOrganized]] = await Promise.all([
    db.select({ value: count() }).from(memories).where(usable),
    db
      .select({ value: count() })
      .from(memories)
      .where(and(usable, isNull(memories.lastConsolidatedAt))),
    db.select({ value: count() }).from(memories).where(review),
    db
      .select({ value: count() })
      .from(memories)
      .where(and(usable, eq(memories.ownerConfirmed, true))),
    db
      .select({ value: max(memories.lastConsolidatedAt) })
      .from(memories)
      .where(and(usable, sql`${memories.lastConsolidatedAt} IS NOT NULL`)),
  ]);

  return {
    totalUsable: total?.value ?? 0,
    notYetOrganized: unorganized?.value ?? 0,
    awaitingReview: awaiting?.value ?? 0,
    ownerConfirmed: confirmed?.value ?? 0,
    lastOrganizedAt: lastOrganized?.value ?? null,
  };
}
