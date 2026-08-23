import { getApplication } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

/**
 * The owner's iPhone posting its current whereabouts (and device time zone)
 * for the ambient prompt line. Transient by design: rows age out with
 * LOCATION_RETENTION_DAYS and never enter memory.
 */
export async function POST(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const body = await request.json().catch(() => null);
  const result = await getApplication().recordOwnerLocationPing(body);
  if (!result.ok) return mobileJson({ error: result.error }, { status: result.status });
  return mobileJson({ ok: true });
}
