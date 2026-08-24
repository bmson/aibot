import { forgetPersonOccasion, reviewPersonOccasion } from '@assistant/application/profile';
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
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid occasion id' }, { status: 400 });
  const body = (await request.json().catch(() => null)) as { verdict?: unknown } | null;
  if (body?.verdict !== 'approve' && body?.verdict !== 'reject') {
    return mobileJson({ error: 'verdict must be approve or reject' }, { status: 400 });
  }
  await reviewPersonOccasion(getDb(), id, body.verdict);
  return mobileJson({ ok: true });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid occasion id' }, { status: 400 });
  await forgetPersonOccasion(getDb(), id);
  return mobileJson({ ok: true });
}
