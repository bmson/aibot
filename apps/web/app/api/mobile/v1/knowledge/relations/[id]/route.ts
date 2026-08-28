import {
  correctKnowledgeGraphRelation,
  reviewKnowledgeGraphRelation,
} from '@assistant/application';
import { getDb, getRouter } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid relationship id' }, { status: 400 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (body?.action === 'confirm' || body?.action === 'reject') {
    await reviewKnowledgeGraphRelation(
      getDb(),
      id,
      body.action === 'confirm' ? 'confirmed' : 'rejected',
    );
    return mobileJson({ ok: true });
  }
  if (body?.action === 'correct') {
    const result = await correctKnowledgeGraphRelation(getDb(), getRouter(), id, {
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
  return mobileJson({ error: 'action must be confirm, reject, or correct' }, { status: 400 });
}
