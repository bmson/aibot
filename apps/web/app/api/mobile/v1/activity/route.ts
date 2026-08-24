import { archiveOldActivity } from '@assistant/application/tasks';
import { getApplication, getDb } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

/** Archived activity is intentionally a separate, on-demand mobile read. */
export async function GET(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const archived = new URL(request.url).searchParams.get('archived') === 'true';
  return mobileJson(await getApplication().listActivity({ archived, filter: 'all', limit: 50 }));
}

export async function POST(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
  if (body?.action !== 'archive-old') {
    return mobileJson({ error: 'action must be archive-old' }, { status: 400 });
  }
  await archiveOldActivity(getDb());
  return mobileJson({ ok: true });
}
