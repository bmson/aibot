import { getApplication } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

/**
 * The iOS app reporting a foreground open — the wake-up signal that can fire
 * the morning brief early (once a day, deduped server-side).
 */
export async function POST(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const result = await getApplication().recordOwnerForeground();
  return mobileJson(result);
}
