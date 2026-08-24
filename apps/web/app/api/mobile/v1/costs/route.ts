import { updateBudgetCaps } from '@assistant/application/costs';
import { getDb } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

/** Update the same default-task, daily, and monthly hard caps as the web costs form. */
export async function PATCH(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || Array.isArray(body)) {
    return mobileJson({ error: 'invalid cost limits body' }, { status: 400 });
  }
  await updateBudgetCaps(getDb(), {
    task_default: typeof body.taskDefault === 'string' ? body.taskDefault : '',
    daily: typeof body.daily === 'string' ? body.daily : '',
    monthly: typeof body.monthly === 'string' ? body.monthly : '',
  });
  return mobileJson({ ok: true });
}
