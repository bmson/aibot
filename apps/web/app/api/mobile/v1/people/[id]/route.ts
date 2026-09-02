import { getPersonDossier } from '@assistant/application/people';
import { toPersonCardView } from '@assistant/application/people-view';
import { getDb } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

// Mirrors the validation the other mobile person routes use, so a malformed id
// is a 400 rather than a 500 from the query layer.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * One person's card. Editing still goes through `memory/people/<id>` — this is
 * the read the card renders from, and it is deliberately separate so the
 * existing PATCH/DELETE/merge contract keeps its shape.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid person id' }, { status: 400 });
  const now = new Date();
  const dossier = await getPersonDossier(getDb(), id, { now });
  if (!dossier) return mobileJson({ error: 'person not found' }, { status: 404 });
  return mobileJson(toPersonCardView(dossier, now));
}
