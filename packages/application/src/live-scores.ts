import { fetchScoreboard, leagueByKey, type ScoreboardGame } from '@assistant/core/sports';

/**
 * The live half of a scoreboard card: re-read the games it shows, straight
 * from the scores provider, with no model and no task. Clients call this only
 * while a game is on and the card is on screen; the provider cache (20s)
 * absorbs several open screens.
 *
 * Only covered league keys and numeric event ids are accepted, and a league's
 * slate is read from the provider's fixed scoreboard path — the request names
 * nothing the server would fetch on its behalf.
 */

export const MAX_LIVE_EVENTS = 10;

export interface LiveScoreRequest {
  league: string;
  eventIds: string[];
}

export type LiveScoreResult =
  | { ok: true; fetchedAt: string; games: ScoreboardGame[] }
  | { ok: false; status: 400 | 502; error: string };

/** Parse `leagues=mlb:401,402;nfl:77` — the compact form both clients send. */
export function parseLiveScoreQuery(value: string | null): LiveScoreRequest[] | undefined {
  if (!value) return undefined;
  const requests: LiveScoreRequest[] = [];
  let total = 0;
  for (const part of value.split(';')) {
    const [league = '', ids = ''] = part.split(':');
    const eventIds = ids.split(',').filter(Boolean);
    total += eventIds.length;
    if (!leagueByKey(league) || !eventIds.length || !eventIds.every((id) => /^\d{1,12}$/.test(id)))
      return undefined;
    requests.push({ league, eventIds });
  }
  return requests.length && total <= MAX_LIVE_EVENTS ? requests : undefined;
}

export async function refreshLiveScores(
  requests: LiveScoreRequest[],
  timeZone: string,
  options: { now?: Date; fetchImpl?: typeof fetch } = {},
): Promise<LiveScoreResult> {
  const now = options.now ?? new Date();
  try {
    const slates = await Promise.all(
      requests.map(async (request) => {
        const league = leagueByKey(request.league);
        if (!league) return [];
        // A game that is on is on the provider's current slate.
        const games = await fetchScoreboard({
          league,
          timeZone,
          now,
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        });
        const wanted = new Set(request.eventIds);
        return games.filter((game) => wanted.has(game.id));
      }),
    );
    return { ok: true, fetchedAt: now.toISOString(), games: slates.flat() };
  } catch (error) {
    console.error('live scores refresh failed', error);
    return { ok: false, status: 502, error: 'The scores provider could not be reached.' };
  }
}
