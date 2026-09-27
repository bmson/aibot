import { clearFlightsCache } from '@assistant/core/flights';
import type { ModelRouter } from '@assistant/core/model-router';
import type {
  GeneratedCardPersistInput,
  GeneratedCardRepository,
  NotificationsConversationRepository,
  WatchCreateInput,
  WatchRecord,
  WatchRepository,
} from '@assistant/persistence';
import { beforeEach, describe, expect, it } from 'vitest';
import { noticeFlightsInEmail } from './email.js';
import { pushFollowedFlights } from './follow.js';

const NOW = new Date('2026-10-01T09:00:00Z');

function stores() {
  const watches: WatchRecord[] = [];
  const cards: GeneratedCardPersistInput[] = [];
  const watchRepository = {
    async create(input: WatchCreateInput) {
      const row = {
        ...input,
        id: `w${watches.length + 1}`,
        agentId: input.agentId,
        status: 'active',
        conversationId: input.conversationId ?? null,
      } as unknown as WatchRecord;
      watches.push(row);
      return row;
    },
    async list(_agentId: string, status?: string) {
      return watches.filter((row) => !status || row.status === status);
    },
    async claimDueWeb(now: Date, _batch: number, _interval: number, kind?: string) {
      return watches.filter(
        (row) =>
          row.kind === kind && row.status === 'active' && row.nextPollAt && row.nextPollAt <= now,
      );
    },
    async updateWeb(input: {
      watchId: string;
      state: unknown;
      nextPollAt?: Date;
      expire?: boolean;
    }) {
      const row = watches.find((candidate) => candidate.id === input.watchId);
      if (!row) return false;
      row.state = input.state;
      if (input.nextPollAt) row.nextPollAt = input.nextPollAt;
      if (input.expire) row.status = 'expired';
      return true;
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

const notifications = {
  kind: 'notifications-conversation-repository',
  getOrCreate: async () => 'notifications-chat',
} as NotificationsConversationRepository;

function router(flights: Array<{ flight: string; date: string }>) {
  return { object: async () => ({ ok: true, object: { flights } }) } as unknown as ModelRouter;
}

const flightRow = {
  ident_iata: 'FI614',
  fa_flight_id: 'ICE614-1764600000-schedule-0001',
  origin: { code_iata: 'KEF', city: 'Reykjavik', timezone: 'Atlantic/Reykjavik' },
  destination: { code_iata: 'JFK', city: 'New York', timezone: 'America/New_York' },
  gate_origin: 'D4',
  departure_delay: 0,
  scheduled_out: '2026-12-01T16:40:00Z',
  scheduled_in: '2026-12-01T22:25:00Z',
};

describe('flights noticed in mail', () => {
  beforeEach(() => clearFlightsCache());

  it('tracks a booked flight, tells the owner once, and card it two days out', async () => {
    const { watches, cards, watchRepository, cardRepository } = stores();
    const notices: string[] = [];
    const email = {
      agentId: 'a1',
      messageId: 'm1',
      from: 'noreply@icelandair.is',
      subject: 'Booking confirmation',
      body: 'Flight FI614 from Reykjavik to New York departs Tue 01 Dec 2026 at 16:40.',
      authenticated: true,
      now: NOW,
    };
    const deps = {
      router: router([{ flight: 'FI614', date: '2026-12-01' }]),
      watches: watchRepository,
      generatedCards: cardRepository,
      notifications,
      notifyOwner: async ({ text }: { text: string }) => {
        notices.push(text);
      },
      apiKey: 'k',
      fetchImpl: async () => Response.json({ flights: [flightRow] }),
    };
    expect(await noticeFlightsInEmail(deps, email)).toBe(1);
    expect(watches[0]).toMatchObject({
      conversationId: 'notifications-chat',
      match: { ident: 'FI614' },
    });
    expect(notices[0]).toContain('Noticed flight FI614 on Tue, Dec 1');

    // The check-in reminder a week later names the same flight: nothing new.
    expect(await noticeFlightsInEmail(deps, { ...email, messageId: 'm2' })).toBe(0);
    expect(notices).toHaveLength(1);

    // Two days out, the sweep turns it into a live card and says so.
    const due = new Date('2026-11-29T00:00:00Z');
    expect(
      await pushFollowedFlights(
        {
          watches: watchRepository,
          apiKey: 'k',
          generatedCards: cardRepository,
          notifyOwner: deps.notifyOwner,
          fetchImpl: deps.fetchImpl,
        },
        due,
      ),
    ).toBe(1);
    expect(cards).toHaveLength(1);
    expect(notices[1]).toMatch(/^FI614 Reykjavik → New York leaves Tue 16:40, on time, gate D4\./);
    expect(watches[0]?.state).toMatchObject({ carded: true, flightId: flightRow.fa_flight_id });
    // Not read again before it expires.
    expect(watches[0]?.nextPollAt).toEqual(watches[0]?.expiresAt);
  });

  it('keeps waiting when FlightAware does not have it yet', async () => {
    const { watches, watchRepository, cardRepository } = stores();
    await noticeFlightsInEmail(
      {
        router: router([{ flight: 'FI614', date: '2026-12-01' }]),
        watches: watchRepository,
        generatedCards: cardRepository,
        notifications,
        notifyOwner: async () => {},
        apiKey: 'k',
      },
      {
        agentId: 'a1',
        messageId: 'm1',
        from: 'x@y.z',
        subject: 'Your itinerary',
        body: 'Flight FI614 on 1 December 2026',
        authenticated: true,
        now: NOW,
      },
    );
    await pushFollowedFlights(
      {
        watches: watchRepository,
        apiKey: 'k',
        generatedCards: cardRepository,
        fetchImpl: async () => Response.json({ flights: [] }),
      },
      new Date('2026-11-29T00:00:00Z'),
    );
    expect(watches[0]?.status).toBe('active');
    expect(watches[0]?.state).toMatchObject({ waiting: true });
  });
});
