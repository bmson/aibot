import {
  getModelProviderSettings,
  saveModelConnection,
  testModelConnection,
} from '@assistant/application/model-providers';
import { getModelProviderPorts } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const optionalString = (value: unknown) => (typeof value === 'string' ? value : undefined);

/** Settings → AI providers for the native app. API keys never appear in a response. */
export async function GET(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  return mobileJson(await getModelProviderSettings(getModelProviderPorts()));
}

/** Connect a provider (or update it), then list its models like the web does. */
export async function POST(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof body?.kind !== 'string')
    return mobileJson({ error: 'kind is required' }, { status: 400 });
  const ports = getModelProviderPorts();
  const saved = await saveModelConnection(ports, {
    kind: body.kind,
    id: optionalString(body.id),
    label: optionalString(body.label),
    apiKey: optionalString(body.apiKey),
    baseUrl: optionalString(body.baseUrl),
    vertexProject: optionalString(body.vertexProject),
    vertexLocation: optionalString(body.vertexLocation),
  });
  if (!saved.ok) return mobileJson({ error: saved.error }, { status: 400 });
  const test = await testModelConnection(ports, saved.id);
  return mobileJson(
    test.ok ? { id: saved.id, models: test.models } : { id: saved.id, testError: test.error },
  );
}
