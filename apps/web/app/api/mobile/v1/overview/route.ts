import { getApplication } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

/** Owner-facing secondary surfaces used by the native tab bar. */
export async function GET(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const application = getApplication();
  const [activity, goals, approvals, documents] = await Promise.all([
    application.listActivity({ archived: false, filter: 'all', limit: 50 }),
    application.listGoals(false),
    application.listApprovals(),
    application.getDocuments(),
  ]);
  return mobileJson({
    generatedAt: new Date().toISOString(),
    activity,
    goals,
    approvals,
    documents,
  });
}
