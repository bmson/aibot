import type { GeneratedCardRepository, WatchRecord, WatchRepository } from '@assistant/persistence';
import { persistGeneratedCard } from '../generative-card.js';
import type { ActionEvidence } from '../workflow/response-contract.js';
import {
  type FlightStatus,
  type FlightsFetch,
  lookupFlight,
  normalizeFlightIdent,
} from './aeroapi.js';
import { flightCardPayload, savableFlightCard } from './card.js';

/**
 * Keeping track of a flight the owner mentioned — in an email, or in chat —
 * before anyone asks about it.
 *
 * FlightAware answers two days ahead at most. A flight inside that window
 * becomes a live card on the Cards page straight away; one further out is
 * filed as a waiting `flight` watch that the sweep picks up two days before
 * departure (modules/flights/follow.ts), when it turns into the same card.
 * Either way the watch is the record that this flight is already known, so a
 * second email about it — the reminder, the check-in nudge — adds nothing.
 */

export interface TrackFlightDeps {
  watches: WatchRepository;
  generatedCards: GeneratedCardRepository;
  apiKey: string;
  fetchImpl?: FlightsFetch;
}

export interface TrackFlightInput {
  agentId: string;
  flight: string;
  /** Departure date in the departure city, YYYY-MM-DD. */
  date: string;
  conversationId?: string | null;
  /** Where the flight was noticed, for the watch's name. */
  source: 'email' | 'chat';
  now: Date;
}

export type TrackFlightOutcome =
  | { outcome: 'carded'; flight: FlightStatus; cardId: string }
  | { outcome: 'waiting'; ident: string; date: string; checkFrom: Date }
  | { outcome: 'known'; ident: string; date: string }
  | { outcome: 'not_found'; ident: string; date: string }
  | { outcome: 'invalid'; reason: string };

/** How far ahead FlightAware can answer, with a little slack for time zones. */
const LOOKUP_AHEAD_MS = 2 * 24 * 60 * 60 * 1000;
/** A flight is worth noticing up to a year out, and not after it has gone. */
const NOTICE_AHEAD_MS = 330 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The waiting watch's identity: which flight, on which day. */
export interface TrackedFlightMatch {
  ident: string;
  date: string;
  flightId?: string;
}

export function trackedFlightMatch(watch: Pick<WatchRecord, 'kind' | 'match'>) {
  if (watch.kind !== 'flight') return undefined;
  const match = watch.match as Partial<TrackedFlightMatch> | null;
  return typeof match?.ident === 'string' && typeof match.date === 'string'
    ? (match as TrackedFlightMatch)
    : undefined;
}

function dayStart(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

async function alreadyTracked(deps: TrackFlightDeps, agentId: string, ident: string, date: string) {
  const active = await deps.watches.list(agentId, 'active', 100);
  return active.some((watch) => {
    const match = trackedFlightMatch(watch);
    return match?.ident === ident && match.date === date;
  });
}

/**
 * Look the flight up and file it as a live saved card. Returns undefined
 * when FlightAware has no such flight on that day (yet).
 */
export async function cardForTrackedFlight(
  deps: TrackFlightDeps,
  input: {
    agentId: string;
    ident: string;
    date: string;
    conversationId?: string | null;
    now: Date;
  },
) {
  const result = await lookupFlight({
    apiKey: deps.apiKey,
    ident: input.ident,
    date: input.date,
    now: input.now,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  if (!result.flight) return undefined;
  const evidence: ActionEvidence[] = [
    {
      toolName: 'flights.status',
      status: 'succeeded',
      args: { flight: input.ident, date: input.date },
      result,
    } as ActionEvidence,
  ];
  const payload = flightCardPayload(evidence, input.now);
  if (!payload) return undefined;
  const saved = await persistGeneratedCard(deps.generatedCards, {
    agentId: input.agentId,
    conversationId: input.conversationId ?? null,
    payload: savableFlightCard(payload),
    evidence,
    sourceText: `Flight ${input.ident} on ${input.date}`,
    ...(payload.live ? { live: payload.live } : {}),
  });
  return { flight: result.flight, cardId: saved.id };
}

export async function trackFlight(
  deps: TrackFlightDeps,
  input: TrackFlightInput,
): Promise<TrackFlightOutcome> {
  const ident = normalizeFlightIdent(input.flight);
  if (!ident) return { outcome: 'invalid', reason: 'not a flight number' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !Number.isFinite(dayStart(input.date)))
    return { outcome: 'invalid', reason: 'not a date' };
  const departs = dayStart(input.date);
  const now = input.now.getTime();
  if (departs < now - DAY_MS || departs > now + NOTICE_AHEAD_MS)
    return { outcome: 'invalid', reason: 'outside the window a flight is worth tracking' };
  if (await alreadyTracked(deps, input.agentId, ident, input.date))
    return { outcome: 'known', ident, date: input.date };

  const name = `${ident} on ${input.date}`;
  const expiresAt = new Date(departs + 2 * DAY_MS);
  if (departs <= now + LOOKUP_AHEAD_MS) {
    const card = await cardForTrackedFlight(deps, { ...input, ident });
    if (!card) return { outcome: 'not_found', ident, date: input.date };
    // The record that this flight is known; nothing left for the sweep.
    await deps.watches.create({
      agentId: input.agentId,
      conversationId: input.conversationId ?? null,
      kind: 'flight',
      tier: 'notify',
      name,
      match: { ident, date: input.date, flightId: card.flight.id },
      maxFires: null,
      expiresAt,
      nextPollAt: null,
      pollIntervalSeconds: null,
      state: { carded: true, source: input.source },
    });
    return { outcome: 'carded', flight: card.flight, cardId: card.cardId };
  }

  const checkFrom = new Date(departs - LOOKUP_AHEAD_MS);
  await deps.watches.create({
    agentId: input.agentId,
    conversationId: input.conversationId ?? null,
    kind: 'flight',
    tier: 'notify',
    name,
    match: { ident, date: input.date },
    maxFires: null,
    expiresAt,
    nextPollAt: checkFrom,
    // Until FlightAware has it: every six hours, from two days out.
    pollIntervalSeconds: 6 * 60 * 60,
    state: { waiting: true, source: input.source },
  });
  return { outcome: 'waiting', ident, date: input.date, checkFrom };
}
