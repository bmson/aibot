import {
  approveQuarantinedMemory,
  cleanKnowledgeProjectionOrphans,
  forgetKnowledgeSource,
  getKnowledgeCleanupFindings,
  retryQuarantinedKnowledgeGraphSources,
} from '@assistant/application';
import { restoreMemory } from '@assistant/application/profile';
import { getDb } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  return mobileJson({ findings: await getKnowledgeCleanupFindings(getDb()) });
}

export async function POST(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const action = typeof body?.action === 'string' ? body.action : '';
  const memoryId = typeof body?.memoryId === 'string' ? body.memoryId : '';
  if (action === 'remove-orphans') await cleanKnowledgeProjectionOrphans(getDb());
  else if (action === 'retry') await retryQuarantinedKnowledgeGraphSources(getDb());
  else if (action === 'forget' && memoryId) await forgetKnowledgeSource(getDb(), memoryId);
  else if (action === 'approve' && memoryId) await approveQuarantinedMemory(getDb(), memoryId);
  else if (action === 'keep' && memoryId) await restoreMemory(getDb(), memoryId);
  else return mobileJson({ error: 'invalid cleanup action' }, { status: 400 });
  return mobileJson({ ok: true });
}
