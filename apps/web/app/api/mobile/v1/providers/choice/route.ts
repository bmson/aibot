import { chooseTextModels, chooseVoiceModel } from '@assistant/application/model-providers';
import { getModelProviderPorts } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

/** Point the main and fast roles at two catalog models, or choose the phone-call voice model. */
export async function PUT(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const body = (await request.json().catch(() => null)) as {
    mainModel?: unknown;
    fastModel?: unknown;
    voiceModel?: unknown;
  } | null;
  if (typeof body?.voiceModel === 'string') {
    const voice = await chooseVoiceModel(getModelProviderPorts(), body.voiceModel);
    return voice.ok
      ? mobileJson({ ok: true })
      : mobileJson({ error: voice.error }, { status: 409 });
  }
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
