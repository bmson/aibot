import { decideSuggestion, snoozeSuggestionUntil } from '@assistant/application/suggestions';
import { getDb } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Answer an inline suggestion card from the phone: the same three buttons the
 * web chat offers, backed by the same use cases. "snoozed" is the web's
 * "Later" — put down until this time tomorrow, not answered.
 *
 * No revalidatePath here, like the other native routes: every page that shows
 * a suggestion is force-dynamic and re-reads its state on the next load.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid suggestion id' }, { status: 400 });

  const body = (await request.json().catch(() => null)) as { decision?: unknown } | null;
  const decision = body?.decision;
  if (decision !== 'accepted' && decision !== 'dismissed' && decision !== 'snoozed') {
    return mobileJson(
      { error: 'decision must be accepted, dismissed, or snoozed' },
      { status: 400 },
    );
  }

  const result =
    decision === 'snoozed'
      ? await snoozeSuggestionUntil(getDb(), id)
      : await decideSuggestion(getDb(), id, decision);
  if (!result.ok) {
    return mobileJson(
      { error: result.reason ?? 'This suggestion could not be updated.' },
      { status: 409 },
    );
  }
  return mobileJson({ ok: true, ...(result.taskId ? { taskId: result.taskId } : {}) });
}
