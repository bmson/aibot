import type {
  GeneratedCardPersistInput,
  GeneratedCardRepository,
  WatchCreateInput,
  WatchRecord,
  WatchRepository,
} from '@assistant/persistence';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ModelRouter } from '../model-router/index.js';
import {
  clearFlightsCache,
  flightsInEmail,
  groundedFlights,
  mayMentionFlight,
  trackFlight,
} from './index.js';

const NOW = new Date('2026-10-01T09:00:00Z');

function flightRow(date: string) {
  return {
    ident_iata: 'FI614',
    fa_flight_id: `ICE614-${Date.parse(date) / 1000}-schedule-0001`,
    origin: {
      code_iata: 'KEF',
      city: 'Reykjavik',
      timezone: 'Atlantic/Reykjavik',
      name: 'Keflavik',
    },
    destination: { code_iata: 'JFK', city: 'New York', timezone: 'America/New_York' },
    gate_origin: 'D4',
    departure_delay: 0,
    scheduled_out: `${date}T16:40:00Z`,
    scheduled_in: `${date}T22:25:00Z`,
  };
}

export function memoryStores() {
  const watches: WatchRecord[] = [];
  const cards: GeneratedCardPersistInput[] = [];
  const watchRepository = {
    async create(input: WatchCreateInput) {
      const row = {
        ...input,
        id: `w${watches.length + 1}`,
        status: 'active',
      } as unknown as WatchRecord;
      watches.push(row);
      return row;
    },
    async list(_agentId: string, status?: string) {
      return watches.filter((row) => !status || row.status === status);
    },
  } as unknown as WatchRepository;
  const cardRepository = {
    kind: 'generated-card-repository',
    async get() {
      return null;
    },
    async createOrRevise(input: GeneratedCardPersistInput) {
      cards.push(input);
      return {
        card: {
          id: `card-${cards.length}`,
          sourceFingerprint: input.sourceFingerprint,
          updatedAt: NOW,
        },
        revision: { id: `rev-${cards.length}` },
      };
    },
  } as unknown as GeneratedCardRepository;
  return { watches, cards, watchRepository, cardRepository };
}

function deps(stores: ReturnType<typeof memoryStores>, flights: unknown[] = []) {
  return {
    watches: stores.watchRepository,
    generatedCards: stores.cardRepository,
    apiKey: 'k',
    fetchImpl: async () => Response.json({ flights }),
  };
}

describe('trackFlight', () => {
  beforeEach(() => clearFlightsCache());
  const input = { agentId: 'a1', flight: 'fi 614', source: 'email' as const, now: NOW };

  it('files a live card at once for a flight inside the two-day window', async () => {
    const stores = memoryStores();
    const result = await trackFlight(deps(stores, [flightRow('2026-10-02')]), {
      ...input,
      date: '2026-10-02',
    });
    expect(result).toMatchObject({ outcome: 'carded', cardId: 'card-1' });
    // The saved card keeps its live wiring beside the spec.
    expect(stores.cards[0]?.spec).toHaveProperty('_live.kind', 'flight');
    expect(stores.watches[0]).toMatchObject({
      kind: 'flight',
      match: { ident: 'FI614', date: '2026-10-02' },
      nextPollAt: null,
    });
  });

  it('waits for a flight further out, checking from two days before', async () => {
    const stores = memoryStores();
    const result = await trackFlight(deps(stores), { ...input, date: '2026-12-01' });
    expect(result).toMatchObject({ outcome: 'waiting', ident: 'FI614', date: '2026-12-01' });
    expect(stores.watches[0]?.nextPollAt).toEqual(new Date('2026-11-29T00:00:00Z'));
    expect(stores.watches[0]?.expiresAt).toEqual(new Date('2026-12-03T00:00:00Z'));
    expect(stores.cards).toEqual([]);
  });

  it('adds nothing for a flight it already knows', async () => {
    const stores = memoryStores();
    await trackFlight(deps(stores), { ...input, date: '2026-12-01' });
    expect(
      await trackFlight(deps(stores), { ...input, flight: 'FI614', date: '2026-12-01' }),
    ).toMatchObject({
      outcome: 'known',
    });
    expect(stores.watches).toHaveLength(1);
  });

  it('refuses what is not a trackable flight', async () => {
    const stores = memoryStores();
    expect(
      await trackFlight(deps(stores), { ...input, flight: 'hello', date: '2026-12-01' }),
    ).toMatchObject({
      outcome: 'invalid',
    });
    expect(await trackFlight(deps(stores), { ...input, date: '2025-01-01' })).toMatchObject({
      outcome: 'invalid',
    });
    expect(await trackFlight(deps(stores), { ...input, date: '2026-10-02' })).toMatchObject({
      outcome: 'not_found',
    });
  });
});

describe('flights in email', () => {
  const confirmation = {
    subject: 'Your Icelandair booking confirmation',
    body: 'Booking reference XJ4K2P. Flight FI 614 Reykjavik (KEF) to New York (JFK), Fri 02 Oct 2026, departs 16:40.',
  };

  it('only reads mail that looks like it carries a flight', () => {
    expect(mayMentionFlight(confirmation.subject, confirmation.body)).toBe(true);
    expect(
      mayMentionFlight('Weekly newsletter', 'Our Q3 results are up 12% and the offsite is at 5.'),
    ).toBe(false);
    expect(mayMentionFlight('Lunch?', 'Want to grab lunch on flight deck street?')).toBe(false);
  });

  it('keeps only flight numbers the email states', () => {
    expect(
      groundedFlights(
        [
          { flight: 'FI614', date: '2026-10-02' },
          { flight: 'FI615', date: '2026-10-09' },
          { flight: 'FI 614', date: '2026-10-02' },
        ],
        `${confirmation.subject}\n${confirmation.body}`,
      ),
    ).toEqual([{ flight: 'FI614', date: '2026-10-02' }]);
  });

  it('asks the model only past the prefilter, and grounds what it returns', async () => {
    let calls = 0;
    const router = {
      async object() {
        calls += 1;
        return {
          ok: true,
          object: {
            flights: [
              { flight: 'FI614', date: '2026-10-02' },
              { flight: 'DL1', date: '2026-10-05' },
            ],
          },
        };
      },
    } as unknown as ModelRouter;
    expect(await flightsInEmail({ router, received: NOW, ...confirmation })).toEqual([
      { flight: 'FI614', date: '2026-10-02' },
    ]);
    expect(
      await flightsInEmail({ router, received: NOW, subject: 'Hi', body: 'See you soon' }),
    ).toEqual([]);
    expect(calls).toBe(1);
  });
});
