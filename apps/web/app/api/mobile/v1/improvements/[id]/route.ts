import { getApplication } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid proposal id' }, { status: 400 });
  const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
  try {
    if (body?.action === 'apply') await getApplication().applyImprovementProposal(id);
    else if (body?.action === 'dismiss') await getApplication().dismissImprovementProposal(id);
    else return mobileJson({ error: 'action must be apply or dismiss' }, { status: 400 });
    return mobileJson({ ok: true });
  } catch (error) {
    return mobileJson(
      { error: error instanceof Error ? error.message : 'Proposal could not be updated.' },
      { status: 409 },
    );
  }
}
