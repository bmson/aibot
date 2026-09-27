import type { WatchCreateInput, WatchRecord, WatchRepository } from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { followFlight, unfollowFlight } from './flight-follow.js';

const ID = 'ICE614-1759300000-schedule-0001';
const TOKEN = 'cd'.repeat(32);
const NOW = new Date('2026-10-02T12:00:00Z');

function memoryWatches() {
  const rows: WatchRecord[] = [];
  const repository = {
    async create(input: WatchCreateInput) {
      const row = {
        ...input,
        id: `w${rows.length + 1}`,
        status: 'active',
      } as unknown as WatchRecord;
      rows.push(row);
      return row;
    },
    async list(_agentId: string, status?: string) {
      return rows.filter((row) => !status || row.status === status);
    },
    async cancel(_agentId: string, watchId: string) {
      const row = rows.find((candidate) => candidate.id === watchId);
      if (row) row.status = 'cancelled';
      return row ? { status: 'cancelled', cancelled: true } : null;
    },
  } as unknown as WatchRepository;
  return { repository, rows };
}

const follow = { flightId: ID, ident: 'FI614', pushToken: TOKEN, environment: 'production' };

describe('followFlight', () => {
  it('files a flight watch holding the activity token', async () => {
    const { repository, rows } = memoryWatches();
    const deps = { watches: repository, agentId: 'a1', conversationId: 'c1' };
    const result = await followFlight(deps, { ...follow, until: '2026-10-02T23:25:00Z' }, NOW);
    expect(result).toEqual({ ok: true, watchId: 'w1' });
    expect(rows[0]).toMatchObject({
      kind: 'flight',
      conversationId: 'c1',
      match: { flightId: ID, ident: 'FI614' },
      state: { pushToken: TOKEN, environment: 'production' },
      expiresAt: new Date('2026-10-02T23:25:00Z'),
      nextPollAt: new Date('2026-10-02T12:01:00Z'),
    });
  });

  it('replaces the watch when the token rotates, instead of adding one', async () => {
    const { repository, rows } = memoryWatches();
    const deps = { watches: repository, agentId: 'a1', conversationId: null };
    await followFlight(deps, follow, NOW);
    await followFlight(deps, { ...follow, pushToken: 'ef'.repeat(32) }, NOW);
    expect(rows.map((row) => row.status)).toEqual(['cancelled', 'active']);
  });

  it('keeps the follow within a sane window', async () => {
    const { repository, rows } = memoryWatches();
    const deps = { watches: repository, agentId: 'a1', conversationId: null };
    await followFlight(deps, { ...follow, until: '2027-01-01T00:00:00Z' }, NOW);
    expect(rows[0]?.expiresAt).toEqual(new Date('2026-10-05T12:00:00Z'));
  });

  it('refuses what is not a flight follow', async () => {
    const { repository } = memoryWatches();
    const deps = { watches: repository, agentId: 'a1', conversationId: null };
    expect(await followFlight(deps, { ...follow, flightId: '../x' }, NOW)).toMatchObject({
      status: 400,
    });
    expect(await followFlight(deps, { ...follow, pushToken: 'xyz' }, NOW)).toMatchObject({
      status: 400,
    });
    expect(await followFlight(deps, null, NOW)).toMatchObject({ status: 400 });
  });

  it('unfollows every watch on that flight', async () => {
    const { repository, rows } = memoryWatches();
    const deps = { watches: repository, agentId: 'a1', conversationId: null };
    await followFlight(deps, follow, NOW);
    expect(await unfollowFlight(deps, { flightId: ID }, NOW)).toEqual({ ok: true });
    expect(rows[0]?.status).toBe('cancelled');
  });
});
