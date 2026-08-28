import {
  getKnowledgeGraphOverview,
  mergeKnowledgeGraphEntities,
  renameKnowledgeGraphEntity,
  retypeKnowledgeGraphEntity,
} from '@assistant/application';
import { getDb } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid knowledge item id' }, { status: 400 });
  // Keep the normal compact browse page alongside the selected detail: the
  // native guided editor needs real candidate items for its second endpoint.
  const graph = await getKnowledgeGraphOverview(getDb(), { entityId: id });
  return graph.selected
    ? mobileJson(graph)
    : mobileJson({ error: 'knowledge item not found' }, { status: 404 });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid knowledge item id' }, { status: 400 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const action = body?.action;
  let result: { error?: string };
  if (action === 'rename') {
    result = await renameKnowledgeGraphEntity(
      getDb(),
      id,
      typeof body?.label === 'string' ? body.label : '',
    );
  } else if (action === 'retype') {
    result = await retypeKnowledgeGraphEntity(
      getDb(),
      id,
      typeof body?.kind === 'string' ? body.kind : '',
    );
  } else if (action === 'merge') {
    result = await mergeKnowledgeGraphEntities(
      getDb(),
      id,
      typeof body?.targetId === 'string' ? body.targetId : '',
    );
  } else {
    return mobileJson({ error: 'action must be rename, retype, or merge' }, { status: 400 });
  }
  return result.error ? mobileJson(result, { status: 409 }) : mobileJson({ ok: true });
}
