import { followOwnerFlight, unfollowOwnerFlight } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

/**
 * The phone following a flight on the Lock Screen: `{ flightId, ident,
 * pushToken, environment, until }`, where the token is the Live Activity's
 * own. Called again whenever ActivityKit rotates that token.
 */
export async function POST(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const result = await followOwnerFlight(await request.json().catch(() => null));
  if (!result.ok) return mobileJson({ error: result.error }, { status: result.status });
  return mobileJson({ ok: true });
}

/** Stop following: `{ flightId }`. The activity was ended on the phone. */
export async function DELETE(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const result = await unfollowOwnerFlight(await request.json().catch(() => null));
  if (!result.ok) return mobileJson({ error: result.error }, { status: result.status });
  return mobileJson({ ok: true });
}
