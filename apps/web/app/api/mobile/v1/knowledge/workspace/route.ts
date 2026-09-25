import { getKnowledgeWorkspaceOverview } from '@assistant/application';
import { loadConfig } from '@assistant/config';
import { getFirestoreKnowledgeWorkspace } from '@/lib/firestore-knowledge';
import { getDb } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  if (loadConfig().PERSISTENCE_DRIVER === 'firestore')
    return mobileJson((await getFirestoreKnowledgeWorkspace().load()).overview);
  return mobileJson(await getKnowledgeWorkspaceOverview(getDb()));
}
