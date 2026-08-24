import {
  deletePerson,
  getPersonProfile,
  mergePeople,
  updatePersonIdentity,
  updatePersonRelationship,
} from '@assistant/application/profile';
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
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid person id' }, { status: 400 });
  const profile = await getPersonProfile(getDb(), id);
  return profile ? mobileJson(profile) : mobileJson({ error: 'person not found' }, { status: 404 });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid person id' }, { status: 400 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || Array.isArray(body)) {
    return mobileJson({ error: 'invalid person body' }, { status: 400 });
  }
  const identity = await updatePersonIdentity(
    getDb(),
    id,
    typeof body.name === 'string' ? body.name : '',
    typeof body.aliases === 'string' ? body.aliases : '',
  );
  if (identity.error) return mobileJson({ error: identity.error }, { status: 400 });
  await updatePersonRelationship(
    getDb(),
    id,
    typeof body.relationship === 'string' ? body.relationship : '',
  );
  return mobileJson({ ok: true });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid person id' }, { status: 400 });
  const body = (await request.json().catch(() => null)) as {
    action?: unknown;
    targetId?: unknown;
  } | null;
  if (
    body?.action !== 'merge' ||
    typeof body.targetId !== 'string' ||
    !UUID_RE.test(body.targetId)
  ) {
    return mobileJson({ error: 'action must be merge with a valid targetId' }, { status: 400 });
  }
  await mergePeople(getDb(), id, body.targetId);
  return mobileJson({ ok: true });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid person id' }, { status: 400 });
  const result = await deletePerson(getDb(), id);
  return result.error
    ? mobileJson({ error: result.error }, { status: 409 })
    : mobileJson({ ok: true });
}
