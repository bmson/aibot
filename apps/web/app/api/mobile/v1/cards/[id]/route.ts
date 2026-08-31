import { dismissSavedCard } from '@assistant/application/cards';
import { getAgentIdentity, getDb } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid card id' }, { status: 400 });
  const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
  if (body?.action !== 'dismiss')
    return mobileJson({ error: 'action must be dismiss' }, { status: 400 });
  const agent = await getAgentIdentity();
  const dismissed = agent.id ? await dismissSavedCard(getDb(), agent.id, id) : false;
  return dismissed
    ? mobileJson({ ok: true })
    : mobileJson({ error: 'card not found' }, { status: 404 });
}
