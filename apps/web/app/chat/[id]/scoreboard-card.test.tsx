import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { cardsReplaceProse, ResponseCards, rendersAllCards } from './response-card';
import { liveScoreQuery, scoreboardShouldPoll, scoreGames } from './scoreboard-card';

const game = (id: string, state: string, extra: Record<string, unknown> = {}) => ({
  id,
  league: 'mlb',
  leagueLabel: 'MLB',
  state,
  statusText: state === 'in' ? 'Top 7th' : state === 'post' ? 'Final' : 'Today 6:45 PM',
  startsAt: '2026-09-22T01:45:00Z',
  link: 'https://www.espn.com/mlb/game/_/gameId/401',
  home: {
    name: 'San Francisco Giants',
    shortName: 'Giants',
    abbreviation: 'SF',
    logo: 'https://a.espncdn.com/i/teamlogos/mlb/500/sf.png',
    score: '5',
    winner: true,
  },
  away: {
    name: 'Minnesota Twins',
    shortName: 'Twins',
    abbreviation: 'MIN',
    score: '2',
    winner: false,
  },
  ...extra,
});

describe('scoreboard polling', () => {
  const now = Date.parse('2026-09-22T01:40:00Z');
  it('polls while a game is on or about to start, and stops when every game is final', () => {
    expect(scoreboardShouldPoll(scoreGames([game('1', 'in')]), now)).toBe(true);
    expect(scoreboardShouldPoll(scoreGames([game('1', 'pre')]), now)).toBe(true);
    expect(
      scoreboardShouldPoll(
        scoreGames([game('1', 'pre', { startsAt: '2026-09-23T01:45:00Z' })]),
        now,
      ),
    ).toBe(false);
    expect(scoreboardShouldPoll(scoreGames([game('1', 'post')]), now)).toBe(false);
  });

  it('asks the live endpoint only for games that can still change', () => {
    expect(
      liveScoreQuery(
        scoreGames([game('1', 'post'), game('2', 'in'), game('3', 'pre', { league: 'nfl' })]),
      ),
    ).toBe('mlb:2;nfl:3');
  });

  it('drops a link that is not the provider game page', () => {
    expect(scoreGames([game('1', 'in', { link: 'https://evil.example/x' })])[0]).not.toHaveProperty(
      'link',
    );
  });
});

describe('scoreboard card', () => {
  const card = {
    kind: 'scoreboard',
    id: 's1',
    title: 'MLB',
    fetchedAt: '2026-09-22T02:10:00Z',
    accompaniesProse: true,
    live: { provider: 'espn', pollSeconds: 30, leagues: [{ league: 'mlb', eventIds: ['2'] }] },
    games: [game('1', 'post'), game('2', 'in')],
  };

  it('renders each game with logos through the image proxy and a live marker', () => {
    expect(rendersAllCards([card])).toBe(true);
    const html = renderToStaticMarkup(
      <ResponseCards cards={[card]} timeZone="America/Los_Angeles" />,
    );
    expect(html).toContain('/api/card-image?url=https%3A%2F%2Fa.espncdn.com');
    expect(html).toContain('Top 7th');
    expect(html).toContain('>Live<');
    expect(html).toContain('Minnesota Twins at San Francisco Giants, Final');
  });

  it('keeps the reply above the board instead of replacing it', () => {
    expect(cardsReplaceProse([card])).toBe(false);
    expect(cardsReplaceProse([{ kind: 'weather', id: 'w' }])).toBe(true);
  });
});
