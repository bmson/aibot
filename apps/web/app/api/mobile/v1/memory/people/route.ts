import { createPerson } from '@assistant/application/profile';
import { getDb } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || Array.isArray(body)) {
    return mobileJson({ error: 'invalid person body' }, { status: 400 });
  }
  const result = await createPerson(getDb(), {
    name: typeof body.name === 'string' ? body.name : '',
    relationship: typeof body.relationship === 'string' ? body.relationship : '',
    aliases: typeof body.aliases === 'string' ? body.aliases : '',
  });
  return result.error
    ? mobileJson({ error: result.error }, { status: 400 })
    : mobileJson(result, { status: 201 });
}
