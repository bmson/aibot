import { parseLiveScoreQuery, refreshLiveScores } from '@assistant/application/live-scores';
import { getAgentTimezone } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

/** Live scoreboard refresh for the iOS app; same contract as /api/live/scoreboard. */
export async function GET(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const requests = parseLiveScoreQuery(new URL(request.url).searchParams.get('leagues'));
  if (!requests) return mobileJson({ error: 'invalid leagues' }, { status: 400 });
  const result = await refreshLiveScores(requests, await getAgentTimezone());
  return result.ok
    ? mobileJson(result)
    : mobileJson({ error: result.error }, { status: result.status });
}
