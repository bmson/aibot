import { getDashboardPresence } from '@assistant/application/dashboard';
import { isAuthed } from '@/auth';
import { getAgentIdentity, getDb } from '@/lib/server';

export const dynamic = 'force-dynamic';

/**
 * Fresh, small status projection for the persistent client shell.
 *
 * Root layouts stay mounted during client navigation, so their server-rendered
 * dashboard snapshot cannot be the only source for a transient activity pill.
 * This intentionally reads only the inexpensive presence query (not the
 * cached, broader shell payload) so a resolved approval can close the pill as
 * soon as the task settles.
 */
export async function GET(): Promise<Response> {
  if (!(await isAuthed())) return Response.json({ error: 'unauthorized' }, { status: 401 });

  const identity = await getAgentIdentity();
  if (!identity.id) return Response.json({ error: 'assistant not configured' }, { status: 503 });

  const dashboard = await getDashboardPresence(getDb(), identity.id);
  return Response.json(
    { presence: dashboard.presence },
    { headers: { 'cache-control': 'no-store' } },
  );
}
