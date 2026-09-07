import { getKnowledgeGraphNeighborhood, getKnowledgeMapSnapshot } from '@assistant/application';
import { getPersonDossier } from '@assistant/application/people';
import { getDb } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Native canvas transport; retains the existing active-source and size bounds. */
export async function GET(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const params = new URL(request.url).searchParams;
  const personId = params.get('person');
  let entityId = params.get('entity');
  if ([personId, entityId].some((id) => id !== null && !UUID_RE.test(id))) {
    return mobileJson({ error: 'Invalid graph identifier.' }, { status: 400 });
  }
  if (personId) {
    const person = await getPersonDossier(getDb(), personId, { factLimit: 1 });
    if (!person) return mobileJson({ error: 'Person not found.' }, { status: 404 });
    entityId = person.entityId;
    if (!entityId)
      return mobileJson({ nodes: [], edges: [], totalEdges: 0, truncated: false, focusId: null });
  }
  const snapshot = await getKnowledgeMapSnapshot(getDb(), {
    entityId: entityId ?? undefined,
    query: params.get('q') ?? '',
    includeVisibleConnections: true,
  });
  if (entityId && snapshot.nodes.length === 0) {
    const { entity } = await getKnowledgeGraphNeighborhood(getDb(), { entityId, limit: 1 });
    if (!entity) return mobileJson({ error: 'Knowledge item not found.' }, { status: 404 });
    snapshot.nodes.push({
      id: entity.id,
      label: entity.label,
      kind: entity.kind,
      degree: 0,
      component: 0,
      contactId: personId,
    });
  }
  return mobileJson({ ...snapshot, focusId: entityId });
}
