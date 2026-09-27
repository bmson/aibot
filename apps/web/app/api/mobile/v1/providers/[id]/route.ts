import {
  addCatalogModel,
  addVoicePreset,
  removeModelConnection,
  setModelConnectionEnabled,
  testModelConnection,
} from '@assistant/application/model-providers';
import { getModelProviderPorts } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const CONNECTION_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** One connection: test, turn on/off, remove, or add one of its models. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!CONNECTION_ID.test(id))
    return mobileJson({ error: 'invalid connection id' }, { status: 400 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const ports = getModelProviderPorts();
  switch (body?.action) {
    case 'test': {
      const result = await testModelConnection(ports, id);
      return result.ok
        ? mobileJson({ models: result.models })
        : mobileJson({ error: result.error }, { status: 502 });
    }
    case 'enable':
    case 'disable': {
      const result = await setModelConnectionEnabled(ports, id, body.action === 'enable');
      return result.ok
        ? mobileJson({ ok: true })
        : mobileJson({ error: result.error }, { status: 409 });
    }
    case 'remove': {
      const result = await removeModelConnection(ports, id);
      return result.ok
        ? mobileJson({ ok: true })
        : mobileJson({ error: result.error }, { status: 409 });
    }
    case 'add_model': {
      if (
        typeof body.model !== 'string' ||
        (typeof body.promptCostPerMTok !== 'string' &&
          typeof body.promptCostPerMTok !== 'number') ||
        (typeof body.completionCostPerMTok !== 'string' &&
          typeof body.completionCostPerMTok !== 'number')
      )
        return mobileJson({ error: 'model and both prices are required' }, { status: 400 });
      const result = await addCatalogModel(ports, {
        connectionId: id,
        model: body.model,
        label: typeof body.label === 'string' ? body.label : undefined,
        promptCostPerMTok: body.promptCostPerMTok,
        completionCostPerMTok: body.completionCostPerMTok,
        thinking: typeof body.thinking === 'boolean' ? body.thinking : undefined,
      });
      return result.ok
        ? mobileJson({ id: result.id })
        : mobileJson({ error: result.error }, { status: 400 });
    }
    case 'add_voice_preset': {
      if (typeof body.model !== 'string')
        return mobileJson({ error: 'model is required' }, { status: 400 });
      const result = await addVoicePreset(ports, { connectionId: id, model: body.model });
      return result.ok
        ? mobileJson({ id: result.id })
        : mobileJson({ error: result.error }, { status: 400 });
    }
    default:
      return mobileJson(
        { error: 'action must be test, enable, disable, remove, add_model, or add_voice_preset' },
        { status: 400 },
      );
  }
}
