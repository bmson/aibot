import { clearFlightsCache } from '@assistant/core/flights';
import type { WatchRecord, WatchRepository } from '@assistant/persistence';
import type { ApnsLiveActivityPush } from '@assistant/tools/modules/push';
import { beforeEach, describe, expect, it } from 'vitest';
import { pushFollowedFlights } from './follow.js';

const ID = 'ICE614-1759300000-schedule-0001';
const TOKEN = 'ab'.repeat(32);
const NOW = new Date('2026-10-02T15:00:00Z');

function flightRow(overrides: Record<string, unknown> = {}) {
  return {
    ident_iata: 'FI614',
    fa_flight_id: ID,
    origin: { code_iata: 'KEF', city: 'Reykjavik', timezone: 'Atlantic/Reykjavik' },
    destination: { code_iata: 'JFK', city: 'New York', timezone: 'America/New_York' },
    gate_origin: 'D4',
    terminal_origin: '1',
    departure_delay: 0,
    scheduled_out: '2026-10-02T16:40:00Z',
    scheduled_in: '2026-10-02T22:25:00Z',
    ...overrides,
  };
}

/** Just enough of a watch repository to run the sweep against. */
function memoryWatches(watch: Partial<WatchRecord>) {
  const row = {
    id: 'w1',
    agentId: 'a1',
    kind: 'flight',
    status: 'active',
    match: { flightId: ID, ident: 'FI614' },
    state: { pushToken: TOKEN, environment: 'production' },
    nextPollAt: NOW,
    expiresAt: new Date('2026-10-03T00:00:00Z'),
    ...watch,
  } as WatchRecord;
  const updates: Array<Record<string, unknown>> = [];
  const repository = {
    async claimDueWeb(now: Date, _batch: number, _interval: number, kind?: string) {
      if (kind !== 'flight' || row.status !== 'active' || !row.nextPollAt || row.nextPollAt > now)
        return [];
      return [{ ...row }];
    },
    async updateWeb(input: {
      state: unknown;
      expire?: boolean;
      nextPollAt?: Date;
      expectedNextPollAt: Date;
    }) {
      updates.push(input as unknown as Record<string, unknown>);
      row.state = input.state;
      if (input.expire) row.status = 'expired';
      if (input.nextPollAt) row.nextPollAt = input.nextPollAt;
      return true;
    },
  } as unknown as WatchRepository;
  return { repository, row, updates };
}

function run(
  watches: WatchRepository,
  flight: Record<string, unknown> | undefined,
  options: { status?: number; unregistered?: boolean; now?: Date } = {},
) {
  const pushes: ApnsLiveActivityPush[] = [];
  const done = pushFollowedFlights(
    {
      watches,
      apiKey: 'k',
      fetchImpl: async () =>
        flight ? Response.json({ flights: [flight] }) : new Response('nope', { status: 500 }),
      sendLiveActivity: async (push) => {
        pushes.push(push);
        return options.status && options.status !== 200
          ? {
              ok: false,
              unregistered: options.unregistered ?? false,
              status: options.status,
              reason: 'x',
            }
          : { ok: true, apnsId: 'id' };
      },
    },
    options.now ?? NOW,
  );
  return done.then((count) => ({ count, pushes }));
}

describe('pushFollowedFlights', () => {
  beforeEach(() => clearFlightsCache());

  it('pushes the first read silently and re-paces the watch', async () => {
    const { repository, row } = memoryWatches({});
    const { count, pushes } = await run(repository, flightRow());
    expect(count).toBe(1);
    expect(pushes[0]).toMatchObject({
      token: TOKEN,
      event: 'update',
      contentState: { gate: 'D4' },
    });
    expect(pushes[0]?.alert).toBeUndefined();
    // 1h40 before departure: every ten minutes.
    expect(row.nextPollAt?.toISOString()).toBe('2026-10-02T15:10:00.000Z');
  });

  it('sends nothing when nothing the owner sees has changed', async () => {
    const { repository, row } = memoryWatches({});
    await run(repository, flightRow());
    clearFlightsCache();
    const later = new Date('2026-10-02T15:10:00Z');
    const { pushes } = await run(repository, flightRow(), { now: later });
    expect(pushes).toEqual([]);
    expect(row.status).toBe('active');
  });

  it('alerts on a gate change', async () => {
    const { repository } = memoryWatches({});
    await run(repository, flightRow());
    clearFlightsCache();
    const { pushes } = await run(repository, flightRow({ gate_origin: 'D6' }), {
      now: new Date('2026-10-02T15:10:00Z'),
    });
    expect(pushes[0]?.alert).toEqual({
      title: 'FI614 gate change',
      body: 'Now departing from gate D6.',
    });
  });

  it('ends the activity at the gate and stops following', async () => {
    const { repository, row } = memoryWatches({});
    const { pushes } = await run(
      repository,
      flightRow({
        actual_out: '2026-10-02T16:42:00Z',
        actual_off: '2026-10-02T16:55:00Z',
        actual_on: '2026-10-02T22:10:00Z',
        actual_in: '2026-10-02T22:18:00Z',
      }),
      { now: new Date('2026-10-02T22:20:00Z') },
    );
    expect(pushes[0]?.event).toBe('end');
    expect(pushes[0]?.dismissalDate).toBe(Date.parse('2026-10-02T23:20:00Z') / 1000);
    expect(row.status).toBe('expired');
  });

  it('stops following an activity the owner dismissed', async () => {
    const { repository, row } = memoryWatches({});
    await run(repository, flightRow(), { status: 410, unregistered: true });
    expect(row.status).toBe('expired');
  });

  it('counts provider failures and gives up after ten', async () => {
    const { repository, row } = memoryWatches({
      state: { pushToken: TOKEN, environment: 'production', failures: 9 },
    });
    const { pushes } = await run(repository, undefined);
    expect(pushes).toEqual([]);
    expect(row.status).toBe('expired');
  });

  it('retires a watch it cannot read', async () => {
    const { repository, row } = memoryWatches({ state: { pushToken: 'not hex!' } });
    await run(repository, flightRow());
    expect(row.status).toBe('expired');
  });
});
