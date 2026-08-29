import {
  correctKnowledgeSource,
  forgetKnowledgeSource,
  getKnowledgeSourceImpact,
} from '@assistant/application';
import { getDb, getRouter } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const impact = await getKnowledgeSourceImpact(getDb(), (await params).id);
  return impact ? mobileJson(impact) : mobileJson({ error: 'source not found' }, { status: 404 });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const result = await correctKnowledgeSource(
    getDb(),
    getRouter(),
    (await params).id,
    typeof body?.content === 'string' ? body.content : '',
  );
  return result.error ? mobileJson(result, { status: 400 }) : mobileJson({ ok: true });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  await forgetKnowledgeSource(getDb(), (await params).id);
  return mobileJson({ ok: true });
}
