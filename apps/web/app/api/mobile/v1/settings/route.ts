import { getApplication } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

/** Update editable identity settings through the same validated command as the web form. */
export async function PATCH(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || Array.isArray(body)) {
    return mobileJson({ error: 'invalid settings body' }, { status: 400 });
  }
  const result = await getApplication().updateSettings({
    timezone: typeof body.timezone === 'string' ? body.timezone : '',
    locale: typeof body.locale === 'string' ? body.locale : '',
    signature: typeof body.signature === 'string' ? body.signature : '',
  });
  return result.error
    ? mobileJson({ error: result.error }, { status: 400 })
    : mobileJson({ ok: true });
}
