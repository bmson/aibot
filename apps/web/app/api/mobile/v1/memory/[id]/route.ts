import {
  approveQuarantinedMemory,
  confirmMemory,
  correctMemory,
  forgetMemory,
  type ProminenceLevel,
  rejectQuarantinedMemory,
  setMemoryProminence,
} from '@assistant/application/profile';
import { getDb, getRouter } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid memory id' }, { status: 400 });
  const body = (await request.json().catch(() => null)) as { content?: unknown } | null;
  if (typeof body?.content !== 'string')
    return mobileJson({ error: 'content is required' }, { status: 400 });
  const result = await correctMemory(getDb(), getRouter(), id, body.content);
  return result.error ? mobileJson(result, { status: 400 }) : mobileJson({ ok: true });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid memory id' }, { status: 400 });
  const body = (await request.json().catch(() => null)) as {
    action?: unknown;
    prominence?: unknown;
  } | null;
  try {
    if (body?.action === 'confirm') await confirmMemory(getDb(), id);
    else if (body?.action === 'approve') await approveQuarantinedMemory(getDb(), id);
    else if (body?.action === 'reject') await rejectQuarantinedMemory(getDb(), id);
    else if (body?.action === 'forget') await forgetMemory(getDb(), id);
    else if (body?.action === 'prominence') {
      if (!['always', 'auto', 'minor'].includes(String(body.prominence))) {
        return mobileJson({ error: 'invalid prominence level' }, { status: 400 });
      }
      await setMemoryProminence(getDb(), id, body.prominence as ProminenceLevel);
    } else {
      return mobileJson(
        { error: 'action must be confirm, approve, reject, forget, or prominence' },
        { status: 400 },
      );
    }
    return mobileJson({ ok: true });
  } catch (error) {
    return mobileJson(
      { error: error instanceof Error ? error.message : 'Memory could not be updated.' },
      { status: 409 },
    );
  }
}
