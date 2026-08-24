import { getApplication } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

function skillInput(
  body: unknown,
): { name: string; preconditions: string; steps: string; gotchas: string } | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'invalid skill body' };
  }
  const value = body as Record<string, unknown>;
  const text = (key: string) => (typeof value[key] === 'string' ? value[key].trim() : '');
  const name = text('name');
  const steps = text('steps');
  if (!name) return { error: 'Name is required.' };
  if (!steps) return { error: 'Steps are required.' };
  return { name, steps, preconditions: text('preconditions'), gotchas: text('gotchas') };
}

export async function POST(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const input = skillInput(await request.json().catch(() => null));
  if ('error' in input) return mobileJson({ error: input.error }, { status: 400 });
  const result = await getApplication().addSkill(input);
  return result.error
    ? mobileJson({ error: result.error }, { status: 409 })
    : mobileJson({ ok: true }, { status: 201 });
}
