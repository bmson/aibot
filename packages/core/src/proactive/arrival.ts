import { type Db, locationPings, tasks } from '@assistant/db';
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { InboundEventSchema } from '../events.js';
import { enqueueTask } from '../workflow/machine.js';

/**
 * Arrival nudges ("restaurant recommendations when I get somewhere"). A ping
 * landing somewhere the owner has NOT been in the last day and a half is an
 * arrival worth one considered look — mealtime in a new place earns a couple
 * of nearby picks; anything routine earns silence. The bounds are structural,
 * not prompt luck: at most one nudge per place-grid per day (idempotency key)
 * and one per 12 hours overall (cooldown), so a day of errands cannot become
 * a drip feed, and a lost/crash-replayed ping cannot send the same note twice.
 */

/** Farther than this from every recent ping counts as "somewhere new". */
const ARRIVAL_DISTANCE_KM = 1.5;
const ARRIVAL_WINDOW_HOURS = 36;
const ARRIVAL_COOLDOWN_HOURS = 12;
const ARRIVAL_MAX_ACCURACY_M = 200;
const ARRIVAL_DWELL_MS = 3 * 60_000;
const ARRIVAL_CONFIRMATION_WINDOW_MS = 30 * 60_000;
const ARRIVAL_STATIONARY_RADIUS_KM = 0.2;

export interface ArrivalPing {
  lat: number;
  lng: number;
  label?: string;
  accuracyM?: number | null;
  capturedAt: Date;
}

function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLng = (bLng - aLng) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

function accurate(ping: ArrivalPing): boolean {
  return (
    Number.isFinite(ping.lat) &&
    Math.abs(ping.lat) <= 90 &&
    Number.isFinite(ping.lng) &&
    Math.abs(ping.lng) <= 180 &&
    ping.accuracyM != null &&
    Number.isFinite(ping.accuracyM) &&
    ping.accuracyM >= 0 &&
    ping.accuracyM <= ARRIVAL_MAX_ACCURACY_M
  );
}

/** Two separated observations suggest a stop; a single drive-by never does. */
export function hasConfirmedArrival(ping: ArrivalPing, earlier: ArrivalPing[], now: Date): boolean {
  const age = now.getTime() - ping.capturedAt.getTime();
  if (!accurate(ping) || !Number.isFinite(age) || age < -5_000 || age > 5 * 60_000) return false;
  const history = earlier
    .filter((row) => row.capturedAt < ping.capturedAt)
    .sort((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime());
  let dwellStart = ping.capturedAt.getTime();
  let index = 0;
  for (; index < history.length; index++) {
    const row = history[index];
    if (!row) break;
    if (
      !accurate(row) ||
      ping.capturedAt.getTime() - row.capturedAt.getTime() > ARRIVAL_CONFIRMATION_WINDOW_MS ||
      haversineKm(ping.lat, ping.lng, row.lat, row.lng) > ARRIVAL_STATIONARY_RADIUS_KM
    )
      break;
    dwellStart = row.capturedAt.getTime();
  }
  if (ping.capturedAt.getTime() - dwellStart < ARRIVAL_DWELL_MS) return false;
  // The confirming observations must not veto their own arrival. Older
  // history still prevents routine places from generating another nudge.
  const baseline = history.slice(index).filter(accurate);
  return (
    baseline.length > 0 &&
    baseline.every((row) => haversineKm(ping.lat, ping.lng, row.lat, row.lng) > ARRIVAL_DISTANCE_KM)
  );
}

/** Owner-local calendar date — the "same place, same day" dedupe granularity. */
function zonedDateKey(timeZone: string, at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/**
 * Evaluate a just-recorded app ping and, on a genuine arrival, enqueue the
 * arrival task. Returns true when a task was created. Never throws into the
 * ingest path — a nudge is a bonus, the ping itself is the payload.
 */
export async function maybeEnqueueArrivalNudge(
  db: Db,
  agent: { id: string; timezone: string },
  ping: ArrivalPing,
  now: Date = new Date(),
): Promise<boolean> {
  if (!accurate(ping)) return false;

  const windowStart = new Date(now.getTime() - ARRIVAL_WINDOW_HOURS * 3600e3);
  const recent = await db
    .select({
      lat: locationPings.lat,
      lng: locationPings.lng,
      accuracyM: locationPings.accuracyM,
      capturedAt: locationPings.capturedAt,
    })
    .from(locationPings)
    .where(
      and(
        eq(locationPings.agentId, agent.id),
        gte(locationPings.capturedAt, windowStart),
        // Strictly before: the just-recorded ping must not veto itself.
        lt(locationPings.capturedAt, ping.capturedAt),
      ),
    )
    .orderBy(desc(locationPings.capturedAt));
  if (
    !hasConfirmedArrival(
      ping,
      recent.map((row) => ({
        ...row,
        lat: Number(row.lat),
        lng: Number(row.lng),
      })),
      now,
    )
  )
    return false;

  const cooldownStart = new Date(now.getTime() - ARRIVAL_COOLDOWN_HOURS * 3600e3);
  const [recentNudge] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.agentId, agent.id),
        sql`${tasks.externalEventId} like 'arrival:%'`,
        gte(tasks.createdAt, cooldownStart),
      ),
    )
    .limit(1);
  if (recentNudge) return false;

  const grid = `${ping.lat.toFixed(2)},${ping.lng.toFixed(2)}`;
  const date = zonedDateKey(agent.timezone, now);
  const where = ping.label?.trim() || 'an unlabeled place';
  const event = InboundEventSchema.parse({
    source: 'internal',
    externalEventId: `arrival:${agent.id}:${date}:${grid}`,
    agentId: agent.id,
    trust: 'assistant',
    payload: {
      instruction:
        `Accurate location observations at least three minutes apart suggest the owner has stopped near a new area: ${where} ` +
        `(lat ${ping.lat.toFixed(4)}, lng ${ping.lng.toFixed(4)}). Decide whether one proactive note is worth a push right now. ` +
        'These are approximate observations, not proof of being inside a particular venue. Check current ambient location; if it has changed or is unavailable, send nothing. ' +
        'Around a local mealtime, one or two well-rated, currently-open restaurant or café picks within a short walk are ' +
        'genuinely useful — run web.search at most once, and only recommend places the search actually returned. ' +
        'In an unfamiliar city or neighbourhood, one concrete orientation tip is welcome. ' +
        'If it is neither mealtime nor somewhere worth remarking on, or the search finds nothing solid, send nothing and ' +
        'finish with an empty reply — no message is the right answer most of the time. ' +
        'When you do reach out, send ONE short message via owner.notify with ping=true naming the area and the pick(s), and stop.',
    },
  });
  const { created } = await enqueueTask(db, {
    event,
    type: 'adhoc',
    budgetUsdLimit: '0.06',
    maxSteps: 6,
  });
  return created;
}
