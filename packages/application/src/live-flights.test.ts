import { clearFlightsCache } from '@assistant/core/flights';
import { beforeEach, describe, expect, it } from 'vitest';
import { refreshLiveFlight } from './live-flights.js';

const ID = 'ICE614-1759300000-schedule-0001';
const flight = {
  ident: 'ICE614',
  ident_iata: 'FI614',
  fa_flight_id: ID,
  origin: { code_iata: 'KEF', city: 'Reykjavik', timezone: 'Atlantic/Reykjavik' },
  destination: { code_iata: 'JFK', city: 'New York', timezone: 'America/New_York' },
  gate_origin: 'D4',
  terminal_origin: '1',
  status: 'Scheduled',
  scheduled_out: '2026-10-02T16:40:00Z',
  scheduled_in: '2026-10-02T22:25:00Z',
};

describe('refreshLiveFlight', () => {
  beforeEach(() => clearFlightsCache());

  it('accepts only a FlightAware flight id', async () => {
    expect(await refreshLiveFlight('../../etc', { apiKey: 'k' })).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(await refreshLiveFlight(null, { apiKey: 'k' })).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it('says so when flight status is not set up', async () => {
    expect(await refreshLiveFlight(ID, { apiKey: '' })).toMatchObject({ ok: false, status: 503 });
  });

  it('re-reads the flight by id and recompiles its card', async () => {
    let url = '';
    const result = await refreshLiveFlight(ID, {
      apiKey: 'k',
      now: new Date('2026-10-02T15:00:00Z'),
      fetchImpl: async (requested) => {
        url = requested;
        return Response.json({ flights: [flight] });
      },
    });
    expect(url).toContain(`/flights/${ID}?ident_type=fa_flight_id`);
    expect(result).toMatchObject({ ok: true, live: { kind: 'flight', id: ID } });
    if (result.ok) expect(result.spec.title).toBe('FI614 to New York');
  });

  it('reports a provider failure without throwing', async () => {
    const result = await refreshLiveFlight(ID, {
      apiKey: 'k',
      fetchImpl: async () => new Response('nope', { status: 500 }),
    });
    expect(result).toMatchObject({ ok: false, status: 502 });
  });
});
