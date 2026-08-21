import { getApplication } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid approval id' }, { status: 400 });

  const body = (await request.json().catch(() => null)) as { decision?: unknown } | null;
  if (body?.decision !== 'approved' && body?.decision !== 'denied') {
    return mobileJson({ error: 'decision must be approved or denied' }, { status: 400 });
  }
  const result = await getApplication().decideApproval(id, body.decision);
  return result.ok ? mobileJson(result) : mobileJson({ error: result.reason }, { status: 409 });
}
