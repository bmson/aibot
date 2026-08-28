import {
  addOwnerKnowledgeGraphFact,
  asGraphEntityKind,
  getKnowledgeGraphOverview,
  getKnowledgeGraphReviewQueue,
} from '@assistant/application';
import { getDb, getRouter } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

/** Compact graph browsing plus the owner-backed connection creator for iPhone. */
export async function GET(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const url = new URL(request.url);
  if (url.searchParams.get('mode') === 'review') {
    return mobileJson({ relations: await getKnowledgeGraphReviewQueue(getDb()) });
  }
  const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
  return mobileJson(
    await getKnowledgeGraphOverview(getDb(), {
      query: url.searchParams.get('q') ?? '',
      kind: asGraphEntityKind(url.searchParams.get('kind') ?? undefined),
      page: Number.isFinite(page) && page > 0 ? page : 1,
    }),
  );
}

export async function POST(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return mobileJson({ error: 'invalid connection body' }, { status: 400 });
  const result = await addOwnerKnowledgeGraphFact(getDb(), getRouter(), {
    subjectLabel: typeof body.subjectLabel === 'string' ? body.subjectLabel : '',
    subjectKind: typeof body.subjectKind === 'string' ? body.subjectKind : '',
    subjectId: typeof body.subjectId === 'string' ? body.subjectId : undefined,
    predicate: typeof body.predicate === 'string' ? body.predicate : '',
    objectLabel: typeof body.objectLabel === 'string' ? body.objectLabel : '',
    objectKind: typeof body.objectKind === 'string' ? body.objectKind : '',
    objectId: typeof body.objectId === 'string' ? body.objectId : undefined,
    note: typeof body.note === 'string' ? body.note : '',
  });
  return result.error ? mobileJson(result, { status: 400 }) : mobileJson(result, { status: 201 });
}
