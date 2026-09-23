import { loadConfig, validateAgentPersistenceConfig } from '@assistant/config';
import { FirestoreMcpConnectionMutationRepository } from '@assistant/firestore';
import { getApplication, getFirestoreInstallationStore } from '@/lib/server';
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
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    if (body?.action === 'refresh')
      return mobileJson(
        { error: 'MCP discovery is unavailable in Firestore mode.' },
        { status: 503 },
      );
    if (body?.action !== 'enable' && body?.action !== 'disable')
      return mobileJson({ error: 'action must be refresh, enable, or disable' }, { status: 400 });
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) return mobileJson({ error: problems.join('; ') }, { status: 503 });
    const store = getFirestoreInstallationStore();
    try {
      const result = await new FirestoreMcpConnectionMutationRepository(
        store,
        config.FIRESTORE_AGENT_ID,
      ).setEnabled(id, body.action === 'enable');
      return result
        ? mobileJson(result)
        : mobileJson({ error: 'MCP connection not found.' }, { status: 404 });
    } catch (error) {
      return mobileJson(
        { error: error instanceof Error ? error.message : 'MCP connection could not be updated.' },
        { status: 409 },
      );
    }
  }
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
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) return mobileJson({ error: problems.join('; ') }, { status: 503 });
    const store = getFirestoreInstallationStore();
    try {
      const deleted = await new FirestoreMcpConnectionMutationRepository(
        store,
        config.FIRESTORE_AGENT_ID,
      ).delete(id);
      return deleted
        ? mobileJson({ ok: true })
        : mobileJson({ error: 'MCP connection not found.' }, { status: 404 });
    } catch (error) {
      return mobileJson(
        { error: error instanceof Error ? error.message : 'MCP connection could not be deleted.' },
        { status: 409 },
      );
    }
  }
  const deleted = await getApplication().deleteMcpConnection(id);
  return deleted
    ? mobileJson({ ok: true })
    : mobileJson({ error: 'MCP connection not found.' }, { status: 404 });
}
