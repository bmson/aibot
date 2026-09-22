/**
 * The leagues the scores lookup covers, keyed by the short name the tool and
 * the live-refresh endpoint accept. Only these paths are ever requested from
 * the provider: no argument can name an arbitrary host or path.
 */
export interface League {
  key: string;
  sport: string;
  league: string;
  label: string;
  /** Words an owner uses for it, matched case-insensitively. */
  aliases: readonly string[];
}

export const LEAGUES: readonly League[] = [
  { key: 'mlb', sport: 'baseball', league: 'mlb', label: 'MLB', aliases: ['mlb', 'baseball'] },
  { key: 'nfl', sport: 'football', league: 'nfl', label: 'NFL', aliases: ['nfl'] },
  { key: 'nba', sport: 'basketball', league: 'nba', label: 'NBA', aliases: ['nba'] },
  { key: 'wnba', sport: 'basketball', league: 'wnba', label: 'WNBA', aliases: ['wnba'] },
  { key: 'nhl', sport: 'hockey', league: 'nhl', label: 'NHL', aliases: ['nhl', 'hockey'] },
  {
    key: 'college-football',
    sport: 'football',
    league: 'college-football',
    label: 'College football',
    aliases: ['college football', 'ncaaf', 'cfb'],
  },
  {
    key: 'mens-college-basketball',
    sport: 'basketball',
    league: 'mens-college-basketball',
    label: "Men's college basketball",
    aliases: ['college basketball', 'ncaab', 'march madness'],
  },
  { key: 'mls', sport: 'soccer', league: 'usa.1', label: 'MLS', aliases: ['mls'] },
  {
    key: 'epl',
    sport: 'soccer',
    league: 'eng.1',
    label: 'Premier League',
    aliases: ['premier league', 'epl', 'english premier league'],
  },
  {
    key: 'laliga',
    sport: 'soccer',
    league: 'esp.1',
    label: 'LaLiga',
    aliases: ['la liga', 'laliga'],
  },
  {
    key: 'bundesliga',
    sport: 'soccer',
    league: 'ger.1',
    label: 'Bundesliga',
    aliases: ['bundesliga'],
  },
  { key: 'serie-a', sport: 'soccer', league: 'ita.1', label: 'Serie A', aliases: ['serie a'] },
  { key: 'ligue-1', sport: 'soccer', league: 'fra.1', label: 'Ligue 1', aliases: ['ligue 1'] },
  {
    key: 'ucl',
    sport: 'soccer',
    league: 'uefa.champions',
    label: 'Champions League',
    aliases: ['champions league', 'ucl'],
  },
];

export const LEAGUE_KEYS = LEAGUES.map((league) => league.key) as [string, ...string[]];

export function leagueByKey(key: string): League | undefined {
  return LEAGUES.find((league) => league.key === key);
}

/** The league a request names ("the NFL", "Premier League"), if any. */
export function leagueNamedIn(text: string): League | undefined {
  const lower = ` ${text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ')} `;
  return LEAGUES.find((league) => league.aliases.some((alias) => lower.includes(` ${alias} `)));
}
