import { getApplication } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid MCP connection id' }, { status: 400 });
  const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
  const application = getApplication();
  const result =
    body?.action === 'refresh'
      ? await application.refreshMcpConnection(id)
      : body?.action === 'enable'
        ? await application.setMcpConnectionEnabled(id, true)
        : body?.action === 'disable'
          ? await application.setMcpConnectionEnabled(id, false)
          : null;
  if (!result)
    return mobileJson({ error: 'action must be refresh, enable, or disable' }, { status: 400 });
  return 'error' in result
    ? mobileJson({ error: result.error }, { status: 404 })
    : mobileJson(result);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid MCP connection id' }, { status: 400 });
  const deleted = await getApplication().deleteMcpConnection(id);
  return deleted
    ? mobileJson({ ok: true })
    : mobileJson({ error: 'MCP connection not found.' }, { status: 404 });
}
