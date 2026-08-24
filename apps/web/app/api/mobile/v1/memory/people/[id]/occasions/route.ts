import { addPersonOccasion } from '@assistant/application/profile';
import { getDb } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid person id' }, { status: 400 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || Array.isArray(body)) {
    return mobileJson({ error: 'invalid occasion body' }, { status: 400 });
  }
  const text = (key: string) => (typeof body[key] === 'string' ? body[key] : '');
  const result = await addPersonOccasion(getDb(), id, {
    kind: text('kind'),
    label: text('label'),
    month: text('month'),
    day: text('day'),
    year: text('year'),
    leadDays: text('leadDays'),
    notes: text('notes'),
  });
  return result.error
    ? mobileJson({ error: result.error }, { status: 400 })
    : mobileJson({ ok: true }, { status: 201 });
}
