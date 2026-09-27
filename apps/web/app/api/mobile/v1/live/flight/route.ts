import { refreshLiveFlight } from '@assistant/application/live-flights';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

/**
 * Live flight refresh for the iOS app: `?id=<FlightAware flight id>`. No
 * model, no task — a flight card calls this while it is on screen.
 */
export async function GET(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const result = await refreshLiveFlight(new URL(request.url).searchParams.get('id'));
  return result.ok
    ? mobileJson(result)
    : mobileJson({ error: result.error }, { status: result.status });
}
