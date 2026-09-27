import { chooseTextModels } from '@assistant/application/model-providers';
import { getModelProviderPorts } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

/** Point the assistant's main and fast roles at two catalog models. */
export async function PUT(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const body = (await request.json().catch(() => null)) as {
    mainModel?: unknown;
    fastModel?: unknown;
  } | null;
  if (typeof body?.mainModel !== 'string' || typeof body.fastModel !== 'string')
    return mobileJson({ error: 'mainModel and fastModel are required' }, { status: 400 });
  const result = await chooseTextModels(getModelProviderPorts(), {
    mainModel: body.mainModel,
    fastModel: body.fastModel,
  });
  return result.ok
    ? mobileJson({ ok: true })
    : mobileJson({ error: result.error }, { status: 409 });
}
