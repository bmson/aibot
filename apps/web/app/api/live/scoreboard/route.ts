import { parseLiveScoreQuery, refreshLiveScores } from '@assistant/application/live-scores';
import { isAuthed } from '@/auth';
import { getAgentTimezone } from '@/lib/server';

/**
 * Live scoreboard refresh for the web transcript: `?leagues=mlb:401,402`.
 * No model, no task — a scoreboard card calls this while a game is on.
 */
export async function GET(req: Request) {
  if (!(await isAuthed())) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const requests = parseLiveScoreQuery(new URL(req.url).searchParams.get('leagues'));
  if (!requests) return Response.json({ error: 'invalid leagues' }, { status: 400 });
  const result = await refreshLiveScores(requests, await getAgentTimezone());
  return result.ok
    ? Response.json(result, { headers: { 'cache-control': 'private, max-age=15' } })
    : Response.json({ error: result.error }, { status: result.status });
}
