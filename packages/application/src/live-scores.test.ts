import { clearSportsCache } from '@assistant/core/sports';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseLiveScoreQuery, refreshLiveScores } from './live-scores.js';

beforeEach(() => clearSportsCache());

describe('parseLiveScoreQuery', () => {
  it('accepts covered leagues with numeric event ids only', () => {
    expect(parseLiveScoreQuery('mlb:401,402;nfl:77')).toEqual([
      { league: 'mlb', eventIds: ['401', '402'] },
      { league: 'nfl', eventIds: ['77'] },
    ]);
    for (const bad of [
      null,
      '',
      'cricket:1',
      'mlb:abc',
      'mlb:',
      'mlb:1/../x',
      `mlb:${'1,'.repeat(11)}1`,
    ])
      expect(parseLiveScoreQuery(bad)).toBeUndefined();
  });
});

describe('refreshLiveScores', () => {
  const event = (id: string, state: string, home: string, away: string) => ({
    id,
    date: '2026-09-22T01:45Z',
    competitions: [
      {
        status: { type: { state, shortDetail: state === 'in' ? 'Top 7th' : 'Final' } },
        competitors: [
          {
            homeAway: 'home',
            score: home,
            team: { id: '26', displayName: 'San Francisco Giants' },
          },
          { homeAway: 'away', score: away, team: { id: '9', displayName: 'Minnesota Twins' } },
        ],
      },
    ],
  });

  it('returns only the requested games, fresh from the provider', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return new Response(
        JSON.stringify({ events: [event('401', 'in', '5', '2'), event('999', 'post', '1', '0')] }),
      );
    }) as unknown as typeof fetch;
    const result = await refreshLiveScores(
      [{ league: 'mlb', eventIds: ['401'] }],
      'America/Los_Angeles',
      {
        fetchImpl,
      },
    );
    expect(result).toMatchObject({
      ok: true,
      games: [{ id: '401', state: 'in', statusText: 'Top 7th' }],
    });
    expect(urls).toEqual(['https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard']);
  });

  it('reports a provider outage as a 502, not an empty board', async () => {
    const fetchImpl = (async () =>
      new Response('nope', { status: 503 })) as unknown as typeof fetch;
    expect(
      await refreshLiveScores([{ league: 'mlb', eventIds: ['401'] }], 'UTC', { fetchImpl }),
    ).toMatchObject({ ok: false, status: 502 });
  });
});
