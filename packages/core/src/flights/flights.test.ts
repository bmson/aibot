import { beforeEach, describe, expect, it } from 'vitest';
import { validateGroundedCard } from '../generative-card.js';
import { detectLiveLookup, nextLiveLookup } from '../workflow/live-lookup.js';
import { flightResponseCards } from '../workflow/response-cards.js';
import type { ActionEvidence } from '../workflow/response-contract.js';
import {
  clearFlightsCache,
  flightCardSpec,
  flightLivePolicy,
  lookupFlight,
  normalizeFlight,
  normalizeFlightIdent,
  pickFlight,
  savableFlightCard,
  zonedIso,
} from './index.js';

const KEF = {
  code: 'BIKF',
  code_iata: 'KEF',
  timezone: 'Atlantic/Reykjavik',
  name: "Keflavik Int'l",
  city: 'Reykjavik',
};
const JFK = {
  code: 'KJFK',
  code_iata: 'JFK',
  timezone: 'America/New_York',
  name: 'John F Kennedy Intl',
  city: 'New York',
};

function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ident: 'ICE614',
    ident_iata: 'FI614',
    fa_flight_id: 'ICE614-1759300000-schedule-0001',
    operator: 'ICE',
    operator_iata: 'FI',
    origin: KEF,
    destination: JFK,
    cancelled: false,
    diverted: false,
    departure_delay: 1500,
    arrival_delay: 600,
    progress_percent: 0,
    status: 'Scheduled / Delayed',
    aircraft_type: 'B38M',
    gate_origin: 'D4',
    terminal_origin: null,
    gate_destination: null,
    terminal_destination: '7',
    baggage_claim: null,
    scheduled_out: '2026-10-02T16:40:00Z',
    estimated_out: '2026-10-02T17:05:00Z',
    actual_out: null,
    actual_off: null,
    actual_on: null,
    scheduled_in: '2026-10-02T22:25:00Z',
    estimated_in: '2026-10-02T22:35:00Z',
    actual_in: null,
    ...overrides,
  };
}

const NOW = new Date('2026-10-02T15:00:00Z');

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected a value');
  return value;
}

describe('flight designators', () => {
  it('normalises what people type and refuses what is not a flight', () => {
    expect(normalizeFlightIdent('fi 614')).toBe('FI614');
    expect(normalizeFlightIdent('UA-1')).toBe('UA1');
    expect(normalizeFlightIdent('BAW283')).toBe('BAW283');
    expect(normalizeFlightIdent('U2 8821')).toBe('U28821');
    expect(normalizeFlightIdent('../flights')).toBeUndefined();
    expect(normalizeFlightIdent('hello')).toBeUndefined();
    expect(normalizeFlightIdent('FI12345')).toBeUndefined();
  });
});

describe('normalizeFlight', () => {
  it('puts every time on its airport clock', () => {
    expect(zonedIso('2026-10-02T22:25:00Z', 'America/New_York')).toBe('2026-10-02T18:25:00-04:00');
    expect(zonedIso('2026-10-02T16:40:00Z', 'Atlantic/Reykjavik')).toBe(
      '2026-10-02T16:40:00+00:00',
    );
    const flight = normalizeFlight(raw());
    expect(flight?.departure).toEqual({
      scheduled: '2026-10-02T16:40:00+00:00',
      estimated: '2026-10-02T17:05:00+00:00',
      best: '2026-10-02T17:05:00+00:00',
    });
    expect(flight?.arrival.best).toBe('2026-10-02T18:35:00-04:00');
  });

  it('reads the phase and the delay the owner cares about', () => {
    const scheduled = normalizeFlight(raw());
    expect(scheduled?.phase).toBe('scheduled');
    expect(scheduled?.statusText).toBe('Delayed 25 min');
    expect(scheduled?.origin.label).toBe('Reykjavik (KEF)');
    expect(scheduled?.progressText).toBeUndefined();

    const inAir = normalizeFlight(
      raw({
        actual_out: '2026-10-02T17:02:00Z',
        actual_off: '2026-10-02T17:15:00Z',
        progress_percent: 45,
      }),
    );
    expect(inAir?.phase).toBe('en_route');
    expect(inAir?.statusText).toBe('In the air, 10 min late');
    expect(inAir?.progressText).toBe('45%');

    expect(normalizeFlight(raw({ cancelled: true }))?.statusText).toBe('Cancelled');
    expect(normalizeFlight(raw({ departure_delay: 0, arrival_delay: 0 }))?.statusText).toBe(
      'On time',
    );
  });

  it('strips control characters from provider text', () => {
    const flight = normalizeFlight(raw({ gate_origin: 'D4‮\u0000' }));
    expect(flight?.gateOrigin).toBe('D4');
  });
});

describe('pickFlight', () => {
  const yesterday = must(
    normalizeFlight(
      raw({
        fa_flight_id: 'ICE614-1759200000-schedule-0001',
        scheduled_out: '2026-10-01T16:40:00Z',
        estimated_out: null,
        actual_out: '2026-10-01T16:45:00Z',
        actual_off: '2026-10-01T16:55:00Z',
        actual_on: '2026-10-01T22:10:00Z',
        actual_in: '2026-10-01T22:20:00Z',
      }),
    ),
  );
  const today = must(normalizeFlight(raw()));
  const tomorrow = must(
    normalizeFlight(
      raw({
        fa_flight_id: 'ICE614-1759400000-schedule-0001',
        scheduled_out: '2026-10-03T16:40:00Z',
        estimated_out: null,
      }),
    ),
  );

  it('takes the next to leave when none is in the air', () => {
    expect(pickFlight([tomorrow, today, yesterday], { now: NOW })).toEqual([today]);
  });

  it('takes the named day', () => {
    expect(pickFlight([tomorrow, today, yesterday], { now: NOW, date: '2026-10-03' })).toEqual([
      tomorrow,
    ]);
  });

  it('prefers the one in the air', () => {
    const flying = must(normalizeFlight(raw({ actual_off: '2026-10-02T17:15:00Z' })));
    expect(pickFlight([tomorrow, flying], { now: NOW })).toEqual([flying]);
  });
});

describe('lookupFlight', () => {
  beforeEach(() => clearFlightsCache());

  it('asks FlightAware for the designator with the key in a header', async () => {
    const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
    const result = await lookupFlight({
      apiKey: 'k',
      ident: 'fi 614',
      now: NOW,
      fetchImpl: async (url, init) => {
        calls.push({ url, ...(init?.headers ? { headers: init.headers } : {}) });
        return Response.json({ flights: [raw()] });
      },
    });
    expect(calls[0]?.url).toBe(
      'https://aeroapi.flightaware.com/aeroapi/flights/FI614?ident_type=designator',
    );
    expect(calls[0]?.headers?.['x-apikey']).toBe('k');
    expect(result.flight?.ident).toBe('FI614');
  });

  it('refuses a non-flight before any request, and reports an empty window', async () => {
    let called = false;
    const fetchImpl = async () => {
      called = true;
      return Response.json({ flights: [] });
    };
    expect(await lookupFlight({ apiKey: 'k', ident: 'a/b', now: NOW, fetchImpl })).toHaveProperty(
      'error',
    );
    expect(called).toBe(false);
    expect(await lookupFlight({ apiKey: 'k', ident: 'FI999', now: NOW, fetchImpl })).toMatchObject({
      notFound: true,
      ident: 'FI999',
    });
  });
});

describe('the flight card', () => {
  function evidence(overrides: Record<string, unknown> = {}): ActionEvidence[] {
    const flight = normalizeFlight(raw(overrides));
    return [
      {
        toolName: 'flights.status',
        status: 'succeeded',
        args: { flight: 'FI614' },
        result: { flight },
      } as ActionEvidence,
    ];
  }

  it('compiles a grounded card before departure: route, gate, countdown', () => {
    const [card] = flightResponseCards(evidence(), NOW);
    expect(card).toMatchObject({
      kind: 'generated-card',
      accompaniesProse: true,
      grounding: 'evidence',
    });
    const spec = (card as unknown as { spec: { title: string; blocks: Array<{ type: string }> } })
      .spec;
    expect(spec.title).toBe('FI614 to New York');
    expect(spec.blocks.map((block) => block.type)).toEqual(['journey', 'metrics', 'countdown']);
    expect((card as { live?: { pollSeconds: number } }).live?.pollSeconds).toBe(600);
  });

  it('shows where you come out once the flight is in the air', () => {
    const [card] = flightResponseCards(
      evidence({
        actual_out: '2026-10-02T17:02:00Z',
        actual_off: '2026-10-02T17:15:00Z',
        progress_percent: 45,
        gate_destination: 'B22',
        baggage_claim: '4',
      }),
      NOW,
    );
    const spec = (
      card as unknown as { spec: { blocks: Array<{ type: string; factIds?: string[] }> } }
    ).spec;
    expect(spec.blocks.map((block) => block.type)).toEqual([
      'journey',
      'metrics',
      'progress',
      'countdown',
    ]);
    expect(spec.blocks[1]?.factIds).toEqual(['arrival_gate', 'arrival_terminal', 'baggage']);
  });

  it('passes the same grounding check as a composed card', () => {
    const flight = must(normalizeFlight(raw()));
    const corpus = JSON.stringify({ flight });
    const spec = must(flightCardSpec(flight, corpus));
    expect(validateGroundedCard(spec, corpus)).toEqual(spec);
    expect(flightCardSpec({ ...flight, gateOrigin: 'Z9' }, corpus)).toBeNull();
  });

  it('saves the card without its live wiring', () => {
    const [card] = flightResponseCards(evidence(), NOW);
    const saved = savableFlightCard(must(card));
    expect(saved).not.toHaveProperty('live');
    expect(saved).not.toHaveProperty('accompaniesProse');
    expect(saved.spec.title).toBe('FI614 to New York');
  });

  it('stops being live at the gate', () => {
    const arrived = must(normalizeFlight(raw({ actual_in: '2026-10-02T22:30:00Z' })));
    expect(flightLivePolicy(arrived, NOW)).toBeUndefined();
    const far = flightLivePolicy(must(normalizeFlight(raw())), new Date('2026-10-01T12:00:00Z'));
    expect(far?.pollSeconds).toBe(1800);
  });
});

describe('flight questions', () => {
  const ask = (content: string) => detectLiveLookup([{ role: 'user', content }]);

  it('route a flight number to the flights tool', () => {
    expect(ask('Is FI614 on time?')?.kind).toBe('flight');
    expect(ask('track flight UA 1')?.kind).toBe('flight');
    expect(ask('when does ba283 land?')?.kind).toBe('flight');
    expect(ask('what gate is my flight DL45 at?')?.kind).toBe('flight');
  });

  it('leave everything else alone', () => {
    expect(ask('my flight is at 5 pm, remind me')?.kind).not.toBe('flight');
    expect(ask('is the M3 update out?')?.kind).not.toBe('flight');
    expect(ask('What is the status of my shipment A123?')?.kind).not.toBe('flight');
    expect(ask('is my order AB1234 delayed?')?.kind).not.toBe('flight');
    expect(ask('is flight B6 1 delayed?')?.kind).toBe('flight');
    expect(ask('what is the Giants score?')?.kind).toBe('sports');
  });

  it('ask the flights tool once', () => {
    const lookup = { kind: 'flight' as const, request: 'Is FI614 on time?' };
    expect(nextLiveLookup(lookup, [])).toEqual({ toolName: 'flights.status' });
    expect(
      nextLiveLookup(lookup, [
        {
          toolName: 'flights.status',
          status: 'succeeded',
          result: { notFound: true },
        } as ActionEvidence,
      ]),
    ).toBeUndefined();
  });
});
