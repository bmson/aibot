import {
  type FlightAlertBasis,
  type FlightStatus,
  type FlightsFetch,
  fetchFlightById,
  flightActivityState,
  flightAlert,
  flightAlertBasis,
  flightLivePolicy,
  flightStateFingerprint,
} from '@assistant/core/flights';
import type { WatchRecord, WatchRepository } from '@assistant/persistence';
import type { ApnsLiveActivityPush, ApnsResult } from '@assistant/tools/modules/push';
import { z } from 'zod';

/**
 * Flights followed on the Lock Screen, kept current while the app is closed.
 *
 * Following a flight files a `flight` watch holding the Live Activity's push
 * token. Each sweep claims the watches that are due, reads each flight again,
 * and pushes the new state only when something the owner would see changed —
 * silently, unless it is a gate change, a cancellation or a delay that grew.
 * The pace is the card's own (`flightLivePolicy`), and a flight at the gate
 * gets a final push that dismisses the activity an hour later.
 */

export const FlightFollowMatchSchema = z.object({
  flightId: z.string().min(1).max(80),
  ident: z.string().min(1).max(12),
});

export const FlightFollowStateSchema = z.object({
  pushToken: z.string().regex(/^[0-9a-f]{16,512}$/i),
  environment: z.enum(['sandbox', 'production']),
  fingerprint: z.string().optional(),
  basis: z
    .object({
      phase: z.string(),
      gate: z.string(),
      terminal: z.string(),
      arrivalGate: z.string(),
      delayMinutes: z.number().optional(),
    })
    .optional(),
  failures: z.number().int().min(0).optional(),
});

export type FlightFollowState = z.infer<typeof FlightFollowStateSchema>;

export interface FlightFollowDeps {
  watches: WatchRepository;
  apiKey: string;
  sendLiveActivity: (push: ApnsLiveActivityPush) => Promise<ApnsResult>;
  fetchImpl?: FlightsFetch;
}

const BATCH = 10;
/** Used only when a watch has no pace of its own. */
const DEFAULT_INTERVAL_SECONDS = 300;
/** A flight FlightAware stops answering for is given up after this many reads. */
const MAX_FAILURES = 10;
/** How long the last state stays on the Lock Screen once the flight is done. */
const DISMISS_AFTER_SECONDS = 60 * 60;

export async function pushFollowedFlights(
  deps: FlightFollowDeps,
  now = new Date(),
): Promise<number> {
  const claimed = await deps.watches.claimDueWeb(now, BATCH, DEFAULT_INTERVAL_SECONDS, 'flight');
  let pushed = 0;
  for (const watch of claimed) {
    if (await pushOne(deps, watch, now).catch(logged(watch))) pushed += 1;
  }
  return pushed;
}

function logged(watch: WatchRecord) {
  return (error: unknown) => {
    console.error(`followed flight ${watch.id} failed`, error);
    return false;
  };
}

async function pushOne(deps: FlightFollowDeps, watch: WatchRecord, now: Date): Promise<boolean> {
  if (!watch.nextPollAt) return false;
  const expectedNextPollAt = watch.nextPollAt;
  const match = FlightFollowMatchSchema.safeParse(watch.match);
  const state = FlightFollowStateSchema.safeParse(watch.state);
  if (!match.success || !state.success) {
    // Nothing to read or nowhere to push: the watch can never do its job.
    await deps.watches.updateWeb({
      watchId: watch.id,
      state: watch.state,
      now,
      expire: true,
      expectedNextPollAt,
    });
    return false;
  }
  const prior = state.data;

  let flight: FlightStatus | undefined;
  try {
    flight = await fetchFlightById({
      apiKey: deps.apiKey,
      id: match.data.flightId,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
  } catch (error) {
    console.error(`followed flight ${watch.id}: FlightAware read failed`, error);
  }
  if (!flight) {
    const failures = (prior.failures ?? 0) + 1;
    await deps.watches.updateWeb({
      watchId: watch.id,
      state: { ...prior, failures },
      now,
      expire: failures >= MAX_FAILURES,
      expectedNextPollAt,
    });
    return false;
  }

  const content = flightActivityState(flight, now);
  const fingerprint = flightStateFingerprint(content);
  const basis: FlightAlertBasis = flightAlertBasis(flight);
  const policy = flightLivePolicy(flight, now);
  const timestamp = Math.floor(now.getTime() / 1000);
  const next: FlightFollowState = { ...prior, fingerprint, basis, failures: 0 };

  if (!policy) {
    // At the gate or cancelled: one last state, then the activity leaves.
    const result = await deps.sendLiveActivity({
      token: prior.pushToken,
      environment: prior.environment,
      event: 'end',
      contentState: { ...content },
      timestamp,
      dismissalDate: timestamp + DISMISS_AFTER_SECONDS,
      ...alertFor(match.data.ident, prior, basis),
    });
    await deps.watches.updateWeb({
      watchId: watch.id,
      state: next,
      now,
      expire: true,
      expectedNextPollAt,
    });
    return result.ok;
  }

  const nextPollAt = new Date(now.getTime() + policy.pollSeconds * 1000);
  if (fingerprint === prior.fingerprint) {
    await deps.watches.updateWeb({
      watchId: watch.id,
      state: next,
      now,
      expectedNextPollAt,
      nextPollAt,
    });
    return false;
  }
  const result = await deps.sendLiveActivity({
    token: prior.pushToken,
    environment: prior.environment,
    event: 'update',
    contentState: { ...content },
    timestamp,
    // Stale if no read lands in three paces: the Lock Screen says so rather
    // than showing a gate that may have moved.
    staleDate: timestamp + policy.pollSeconds * 3,
    ...alertFor(match.data.ident, prior, basis),
  });
  await deps.watches.updateWeb({
    watchId: watch.id,
    // An activity the owner dismissed answers 410: stop reading its flight.
    state: result.ok ? next : prior,
    now,
    expire: !result.ok && result.unregistered,
    expectedNextPollAt,
    nextPollAt,
  });
  return result.ok;
}

function alertFor(
  ident: string,
  prior: FlightFollowState,
  basis: FlightAlertBasis,
): { alert?: { title: string; body: string } } {
  const alert = flightAlert(ident, prior.basis, basis);
  return alert ? { alert } : {};
}
