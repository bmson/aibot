import {
  archiveActivity,
  cancelActivity,
  raiseTaskBudget,
  restoreActivity,
  retryActivity,
  revokeTaskAutonomy,
} from '@assistant/application/tasks';
import { getDb } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Archive and restore use the same non-destructive activity commands as the web UI. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid activity id' }, { status: 400 });
  const body = (await request.json().catch(() => null)) as {
    action?: unknown;
    budgetUsdLimit?: unknown;
  } | null;
  try {
    if (body?.action === 'archive') await archiveActivity(getDb(), id);
    else if (body?.action === 'restore') await restoreActivity(getDb(), id);
    else if (body?.action === 'retry') await retryActivity(getDb(), id);
    else if (body?.action === 'cancel') await cancelActivity(getDb(), id);
    else if (body?.action === 'revoke-autonomy') await revokeTaskAutonomy(getDb(), id);
    else if (body?.action === 'raise-budget') {
      const budget = Number(body.budgetUsdLimit);
      if (!Number.isFinite(budget)) {
        return mobileJson({ error: 'budgetUsdLimit must be a number' }, { status: 400 });
      }
      await raiseTaskBudget(getDb(), id, budget);
    } else {
      return mobileJson(
        {
          error: 'action must be archive, restore, retry, cancel, revoke-autonomy, or raise-budget',
        },
        { status: 400 },
      );
    }
    return mobileJson({ ok: true });
  } catch (error) {
    return mobileJson(
      { error: error instanceof Error ? error.message : 'Activity could not be updated.' },
      { status: 409 },
    );
  }
}
