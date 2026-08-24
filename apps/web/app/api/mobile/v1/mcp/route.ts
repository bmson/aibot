import { getApplication } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

/** Owner-managed MCP servers, surfaced in the native app's Connections view. */
export async function GET(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  return mobileJson({ connections: await getApplication().listMcpConnections() });
}

export async function POST(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const body = (await request.json().catch(() => null)) as {
    name?: unknown;
    endpoint?: unknown;
  } | null;
  if (typeof body?.name !== 'string' || typeof body.endpoint !== 'string') {
    return mobileJson({ error: 'name and endpoint are required' }, { status: 400 });
  }
  const result = await getApplication().addMcpConnection({
    name: body.name,
    endpoint: body.endpoint,
  });
  return 'error' in result
    ? mobileJson(
        { error: result.error },
        { status: result.error === 'MCP connection not found.' ? 404 : 400 },
      )
    : mobileJson(result, { status: 201 });
}
