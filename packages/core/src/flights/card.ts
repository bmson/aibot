import { createHash, randomUUID } from 'node:crypto';
import {
  type GeneratedCardPayload,
  type GenerativeCardSpecV1,
  validateGroundedCard,
} from '../generative-card.js';
import type { ActionEvidence } from '../workflow/response-contract.js';
import { type FlightStatus, flightLivePolicy } from './aeroapi.js';

/**
 * A flight card compiled from the status row, with no model. A flight is
 * already structured — composing it again would only add a way to get the
 * gate wrong. Every value is a field of the row, and the result goes through
 * the same grounding check as a composed card.
 */

export const FLIGHTS_SOURCE_LABEL = 'FlightAware';

function flightRows(evidence: ActionEvidence[]): Array<{ flight: FlightStatus; corpus: string }> {
  return evidence.flatMap((row) => {
    if (
      row.toolName !== 'flights.status' ||
      row.status !== 'succeeded' ||
      row.fromCurrentTask === false
    )
      return [];
    const flight = (row.result as { flight?: FlightStatus } | null)?.flight;
    return flight?.id ? [{ flight, corpus: JSON.stringify(row.result) }] : [];
  });
}

export function flightCardSpec(flight: FlightStatus, corpus: string): GenerativeCardSpecV1 | null {
  const facts: GenerativeCardSpecV1['facts'] = [];
  const fact = (id: string, value: string | undefined, label: string) => {
    if (!value) return undefined;
    facts.push({ id, value, label, source: FLIGHTS_SOURCE_LABEL, sensitive: false });
    return id;
  };
  const from = fact('from', flight.origin.label, 'From');
  const to = fact('to', flight.destination.label, 'To');
  const depart = fact('depart', flight.departure.best, 'Departs');
  const arrive = fact('arrive', flight.arrival.best, 'Arrives');
  const status = fact('status', flight.statusText, 'Status');
  const inAir = ['en_route', 'landed'].includes(flight.phase);
  // Before takeoff the owner is looking for their gate; after it, for where
  // they come out at the other end.
  const metrics = (
    inAir || flight.phase === 'arrived'
      ? [
          fact('arrival_gate', flight.gateDestination, 'Arrival gate'),
          fact('arrival_terminal', flight.terminalDestination, 'Terminal'),
          fact('baggage', flight.baggageClaim, 'Baggage'),
        ]
      : [
          fact('gate', flight.gateOrigin, 'Gate'),
          fact('terminal', flight.terminalOrigin, 'Terminal'),
          fact('aircraft', flight.aircraftType, 'Aircraft'),
        ]
  ).filter((id): id is string => Boolean(id));
  const progress = fact('progress', flight.progressText, 'Flight progress');

  const blocks: GenerativeCardSpecV1['blocks'] = [];
  if (from && to)
    blocks.push({
      type: 'journey',
      mode: 'flight',
      fromFact: from,
      toFact: to,
      ...(depart ? { departFact: depart } : {}),
      ...(arrive ? { arriveFact: arrive } : {}),
      ...(status ? { statusFact: status } : {}),
    });
  if (metrics.length >= 2) blocks.push({ type: 'metrics', factIds: metrics.slice(0, 4) });
  else if (metrics.length === 1) blocks.push({ type: 'facts', factIds: metrics });
  if (progress) blocks.push({ type: 'progress', valueFact: progress });
  const countdownTo =
    flight.phase === 'scheduled' || flight.phase === 'taxiing'
      ? depart
      : flight.phase === 'en_route'
        ? arrive
        : undefined;
  if (countdownTo) blocks.push({ type: 'countdown', dateFact: countdownTo });
  if (!blocks.length) return null;

  const place = flight.destination.city || flight.destination.code;
  return validateGroundedCard(
    {
      version: 1,
      // No subtitle: the journey block already carries the status.
      title: place ? `${flight.ident} to ${place}` : flight.ident,
      icon: 'plane',
      accent: ['cancelled', 'diverted'].includes(flight.phase) ? 'rose' : 'sky',
      accessibilityLabel: flight.line.slice(0, 200) || flight.ident,
      facts,
      blocks,
      actions: [],
      // The chat's copy follows the flight live; a saved copy is made
      // refreshable by persistGeneratedCard from its recorded source.
      refreshable: false,
      sourceLabel: FLIGHTS_SOURCE_LABEL,
    },
    corpus,
  );
}

/**
 * The runtime's finding about a flight card: which flight it follows, how
 * often a client should read it again and until when, and the structured
 * status a Lock Screen activity draws from. It rides the payload beside the
 * spec, never inside it — the composer never claims a card is live.
 */
export interface FlightLive {
  kind: 'flight';
  id: string;
  pollSeconds: number;
  until: string;
  flight: FlightStatus;
}

export type LiveGeneratedCardPayload = GeneratedCardPayload & { live?: FlightLive };

export function flightLive(flight: FlightStatus, now: Date): FlightLive | undefined {
  const policy = flightLivePolicy(flight, now);
  return policy ? { kind: 'flight', id: flight.id, ...policy, flight } : undefined;
}

/** The chat's flight card for this turn, when a status lookup found one. */
export function flightCardPayload(
  evidence: ActionEvidence[],
  now: Date,
): LiveGeneratedCardPayload | null {
  const row = flightRows(evidence).at(-1);
  if (!row) return null;
  const spec = flightCardSpec(row.flight, row.corpus);
  if (!spec) return null;
  const live = flightLive(row.flight, now);
  return {
    kind: 'generated-card',
    id: randomUUID(),
    revisionId: randomUUID(),
    spec,
    sourceFingerprint: createHash('sha256').update(`flight:${row.flight.id}`).digest('hex'),
    grounding: 'evidence',
    updatedAt: now.toISOString(),
    ...(live ? { live } : {}),
  };
}

/**
 * The part of a flight card the Cards page keeps: the card, not the chat's
 * live wiring or its placement under the reply.
 */
export function savableFlightCard(card: object): GeneratedCardPayload {
  const {
    live: _live,
    accompaniesProse: _accompanies,
    ...saved
  } = card as LiveGeneratedCardPayload & { accompaniesProse?: boolean };
  return saved;
}
