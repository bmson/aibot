import { getApplication } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

/**
 * The iOS app registering its APNs device token for proactive pushes. Called
 * on every launch (and whenever APNs rotates the token) — idempotent by token.
 */
export async function POST(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const body = await request.json().catch(() => null);
  const result = await getApplication().registerDeviceToken(body);
  if (!result.ok) return mobileJson({ error: result.error }, { status: result.status });
  return mobileJson({ ok: true });
}
