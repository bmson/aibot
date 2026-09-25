import { createPostgresNudgePolicyRepository, type Db, proactivePings } from '@assistant/db';
import type {
  NudgePolicyRepository,
  OutOfBandPingInput,
  PingDecision,
} from '@assistant/persistence';
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';

/**
 * The nudge policy: when a proactive notice may interrupt the owner (SMS,
 * push) versus only land silently on the dashboard. Two owner-set bounds,
 * both off until opted in (an absent prefs row allows everything):
 *
 * - **Quiet hours** — an owner-local window (which may cross midnight) in
 *   which ambient pings are held back.
 * - **Ambient daily cap** — at most N ambient interruptions per owner-local
 *   day, so many independent producers cannot become a drip feed. A briefing,
 *   a watch, and an arrival nudge each know nothing about the others; this
 *   counter is the only place they meet.
 *
 * Interrupt-urgency pings (an approval waiting on the owner, work they asked
 * for stalling) are never gated: the owner is the one waiting. The dashboard
 * copy of every notice posts regardless — suppression only ever holds the
 * phone legs, so a held notice is found, not lost.
 *
 * Every evaluation writes a `proactive_pings` ledger row, delivered or not,
 * so "why didn't my phone buzz?" has an answer.
 */

export type { PingDecision, PingSuppression, PingUrgency } from '@assistant/persistence';

/**
 * Evaluate one out-of-band ping through the selected adapter. The PostgreSQL
 * and Firestore adapters share the owner-local clock and quiet-hours helpers,
 * and one behavioral contract suite, so the policy is identical on both.
 */
export function evaluateOutOfBandPing(
  store: Db | NudgePolicyRepository,
  agent: { id: string; timezone: string },
  opts: OutOfBandPingInput,
): Promise<PingDecision> {
  const repository =
    'kind' in store && store.kind === 'nudge-policy-repository'
      ? (store as NudgePolicyRepository)
      : createPostgresNudgePolicyRepository(store as Db);
  return repository.evaluate(agent, opts);
}

/**
 * Pings the policy held back since a moment — the "while you were quiet"
 * line on Settings, so suppression is visible rather than silent.
 */
export async function countHeldPings(
  db: Db,
  agentId: string,
  since: Date,
): Promise<{ quietHours: number; dailyCap: number }> {
  const rows = await db
    .select({ reason: proactivePings.reason })
    .from(proactivePings)
    .where(
      and(
        eq(proactivePings.agentId, agentId),
        eq(proactivePings.delivered, false),
        gte(proactivePings.createdAt, since),
      ),
    );
  return {
    quietHours: rows.filter((row) => row.reason === 'quiet-hours').length,
    dailyCap: rows.filter((row) => row.reason === 'daily-cap').length,
  };
}

/** The ledger is operational telemetry: purge past the retention window. */
export async function purgeStaleProactivePings(
  db: Db,
  retentionDays = 90,
  batch = 500,
): Promise<number> {
  const days = Number.isFinite(retentionDays) ? Math.max(1, Math.trunc(retentionDays)) : 90;
  const limit = Number.isFinite(batch) ? Math.max(1, Math.trunc(batch)) : 500;
  const cutoff = sql`now() - make_interval(days => ${days})`;
  const stale = db
    .select({ id: proactivePings.id })
    .from(proactivePings)
    .where(lt(proactivePings.createdAt, cutoff))
    .limit(limit);
  const deleted = await db
    .delete(proactivePings)
    .where(inArray(proactivePings.id, stale))
    .returning({ id: proactivePings.id });
  return deleted.length;
}
