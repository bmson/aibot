import {
  type FetchImpl,
  fetchScoreboard,
  fetchTeamSchedule,
  fetchTeams,
  type ScoreboardGame,
  type Team,
} from './espn.js';
import { LEAGUES, type League, leagueByKey } from './leagues.js';

/**
 * "What's the Giants score?" as structured games: today's game for the team,
 * or its last result and next fixture when it has none today. A name that
 * fits several teams ("Giants", "Spurs") returns every one that plays on the
 * day; with none playing, it returns the candidates so the model can ask.
 */

export interface SportsCandidate {
  name: string;
  league: string;
  leagueLabel: string;
}

export interface SportsLookupResult {
  timeZone: string;
  /** Owner-local YYYY-MM-DD the lookup was about. */
  date: string;
  fetchedAt: string;
  games: ScoreboardGame[];
  /** Why these games: today's slate, or a team's last and next when it has none today. */
  selection?: 'today' | 'last-and-next';
  candidates?: SportsCandidate[];
  /** No covered team or league matched; a web search is the fallback. */
  unsupported?: boolean;
  error?: string;
}

const MAX_GAMES = 16;
const MAX_CANDIDATES = 4;

/** Nicknames owners use that the provider does not carry. */
const ALIASES: Record<string, string> = {
  niners: '49ers',
  dubs: 'warriors',
  yanks: 'yankees',
  'man united': 'manchester united',
  'man utd': 'manchester united',
  'man city': 'manchester city',
  barca: 'barcelona',
  'real madrid': 'real madrid',
  bayern: 'bayern munich',
  psg: 'paris saint-germain',
  habs: 'canadiens',
  sixers: '76ers',
  cavs: 'cavaliers',
  mavs: 'mavericks',
  wolves: 'timberwolves',
};

function normal(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(?:the|fc|cf|sc|afc)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whether `query` names `team`: a full name, a nickname, a place + nickname, or a code. */
export function teamMatches(team: Team, query: string): boolean {
  const q = normal(ALIASES[normal(query)] ?? query);
  if (!q) return false;
  const names = [team.name, team.shortName, team.nickname, `${team.location} ${team.nickname}`]
    .map(normal)
    .filter(Boolean);
  if (names.includes(q)) return true;
  if (q.length <= 4 && normal(team.abbreviation) === q) return true;
  // "sf giants", "giants baseball": the nickname plus words that each name
  // this team's place, code, or league — so "sf giants" is not New York's.
  const words = q.split(' ');
  const nickname = normal(team.nickname).split(' ').filter(Boolean);
  if (nickname.length && q.length >= 4 && nickname.every((word) => words.includes(word))) {
    const context = new Set(
      [team.location, team.abbreviation, ...(leagueByKey(team.league)?.aliases ?? [])]
        .flatMap((value) => normal(value).split(' '))
        .filter(Boolean),
    );
    if (words.filter((word) => !nickname.includes(word)).every((word) => context.has(word)))
      return true;
  }
  // "manchester united" inside "manchester united football club": only a full
  // name counts here, or "sf giants" would contain New York's nickname.
  const full = [team.name, `${team.location} ${team.nickname}`].map(normal);
  return full.some((name) => name.length >= 5 && q.includes(name));
}

function ownerToday(timeZone: string, now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function involves(game: ScoreboardGame, team: Team): boolean {
  return game.home.id === team.id || game.away.id === team.id;
}

export async function lookupScores(input: {
  team?: string;
  league?: string;
  date?: string;
  timeZone: string;
  now?: Date;
  fetchImpl?: FetchImpl;
  signal?: AbortSignal;
}): Promise<SportsLookupResult> {
  const now = input.now ?? new Date();
  const date = input.date ?? ownerToday(input.timeZone, now);
  const base = { timeZone: input.timeZone, date, fetchedAt: now.toISOString() };
  const shared = {
    timeZone: input.timeZone,
    fetchImpl: input.fetchImpl,
    signal: input.signal,
    now,
  };
  const named = input.league ? leagueByKey(input.league) : undefined;
  const team = input.team?.trim();

  if (!team) {
    if (!named) return { ...base, games: [], error: 'Name a team or a league.' };
    const games = await fetchScoreboard({ league: named, date, ...shared });
    return { ...base, games: games.slice(0, MAX_GAMES), selection: 'today' };
  }

  const leagues: readonly League[] = named ? [named] : LEAGUES;
  const rosters = await Promise.allSettled(
    leagues.map((league) =>
      fetchTeams({ league, fetchImpl: input.fetchImpl, signal: input.signal }),
    ),
  );
  const matches = rosters
    .flatMap((roster) => (roster.status === 'fulfilled' ? roster.value : []))
    .filter((candidate) => teamMatches(candidate, team))
    .slice(0, MAX_CANDIDATES);
  if (!matches.length) {
    return {
      ...base,
      games: [],
      unsupported: true,
      error: `No team in the covered leagues matched "${team.slice(0, 60)}".`,
    };
  }

  const todays = await Promise.all(
    matches.map(async (match) => {
      const league = leagueByKey(match.league) as League;
      const games = await fetchScoreboard({ league, date, ...shared }).catch(() => []);
      return games.filter((game) => involves(game, match));
    }),
  );
  const playing = todays.flat();
  if (playing.length) return { ...base, games: playing, selection: 'today' };

  if (matches.length > 1) {
    return {
      ...base,
      games: [],
      candidates: matches.map((match) => ({
        name: match.name,
        league: match.league,
        leagueLabel: leagueByKey(match.league)?.label ?? match.league,
      })),
    };
  }

  const [match] = matches as [Team];
  const league = leagueByKey(match.league) as League;
  const season = await fetchTeamSchedule({ league, teamId: match.id, ...shared });
  const last = season.filter((game) => game.state !== 'pre').at(-1);
  const next = season.find(
    (game) => game.state === 'pre' && Date.parse(game.startsAt) > now.getTime(),
  );
  const games = [last, next].filter((game): game is ScoreboardGame => !!game);
  return { ...base, games, selection: 'last-and-next' };
}
