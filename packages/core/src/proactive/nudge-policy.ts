import { type Db, notificationPrefs, proactivePings } from '@assistant/db';
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

export type PingUrgency = 'ambient' | 'interrupt';
export type PingSuppression = 'quiet-hours' | 'daily-cap';

export interface PingDecision {
  deliver: boolean;
  reason?: PingSuppression;
}

/** Wall-clock minutes after midnight in the zone, for the quiet-hours window. */
function localMinutes(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return hour * 60 + minute;
}

/** The zone's offset from UTC at a given instant, in milliseconds. */
function tzOffsetMs(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asIfUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  return asIfUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The UTC instant of the owner's local midnight at `now` (DST-refined once). */
function localMidnightUtc(timeZone: string, now: Date): Date {
  const [year = 1970, month = 1, day = 1] = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(now)
    .split('-')
    .map(Number);
  const midnightAsIfUtc = Date.UTC(year, month - 1, day);
  const guess = midnightAsIfUtc - tzOffsetMs(timeZone, new Date(midnightAsIfUtc));
  return new Date(midnightAsIfUtc - tzOffsetMs(timeZone, new Date(guess)));
}

function insideQuietHours(
  prefs: { quietStartMin: number | null; quietEndMin: number | null },
  minutes: number,
): boolean {
  const { quietStartMin: start, quietEndMin: end } = prefs;
  // An unset or zero-width window is off, not "quiet forever".
  if (start == null || end == null || start === end) return false;
  // A start after the end is an overnight window (22:00 → 07:00).
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

export async function evaluateOutOfBandPing(
  db: Db,
  agent: { id: string; timezone: string },
  opts: { urgency: PingUrgency; channel?: string; now?: Date },
): Promise<PingDecision> {
  const now = opts.now ?? new Date();
  const channel = opts.channel ?? 'out-of-band';

  let decision: PingDecision = { deliver: true };
  if (opts.urgency === 'ambient') {
    const [prefs] = await db
      .select()
      .from(notificationPrefs)
      .where(eq(notificationPrefs.agentId, agent.id))
      .limit(1);
    if (prefs && insideQuietHours(prefs, localMinutes(agent.timezone, now))) {
      decision = { deliver: false, reason: 'quiet-hours' };
    } else if (prefs?.ambientDailyCap != null) {
      const sinceMidnight = await db
        .select({ id: proactivePings.id })
        .from(proactivePings)
        .where(
          and(
            eq(proactivePings.agentId, agent.id),
            eq(proactivePings.urgency, 'ambient'),
            eq(proactivePings.delivered, true),
            gte(proactivePings.createdAt, localMidnightUtc(agent.timezone, now)),
          ),
        );
      if (sinceMidnight.length >= prefs.ambientDailyCap) {
        decision = { deliver: false, reason: 'daily-cap' };
      }
    }
  }

  await db.insert(proactivePings).values({
    agentId: agent.id,
    urgency: opts.urgency,
    channel,
    delivered: decision.deliver,
    reason: decision.reason ?? null,
    // The evaluation's own clock, not insert time: a caller pinning `now`
    // (tests, a replayed sweep) must land its row inside the day it judged.
    createdAt: now,
  });
  return decision;
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
