import { getKnowledgeWorkspaceOverview } from '@assistant/application';
import { getDb } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  return mobileJson(await getKnowledgeWorkspaceOverview(getDb()));
}
