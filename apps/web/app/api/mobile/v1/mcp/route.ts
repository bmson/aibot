import { loadConfig, validateAgentPersistenceConfig } from '@assistant/config';
import {
  FirestoreMcpConnectionMutationRepository,
  FirestoreMcpConnectionReadRepository,
} from '@assistant/firestore';
import {
  encryptMcpConnectionBearerToken,
  getApplication,
  getFirestoreInstallationStore,
} from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

/** Owner-managed MCP servers, surfaced in the native app's Connections view. */
export async function GET(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) return mobileJson({ error: problems.join('; ') }, { status: 503 });
    const repository = new FirestoreMcpConnectionReadRepository(
      getFirestoreInstallationStore(),
      config.FIRESTORE_AGENT_ID,
    );
    return mobileJson({ connections: await repository.list(config.FIRESTORE_AGENT_ID) });
  }
  return mobileJson({ connections: await getApplication().listMcpConnections() });
}

export async function POST(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const body = (await request.json().catch(() => null)) as {
    name?: unknown;
    endpoint?: unknown;
    bearerToken?: unknown;
  } | null;
  if (typeof body?.name !== 'string' || typeof body.endpoint !== 'string') {
    return mobileJson({ error: 'name and endpoint are required' }, { status: 400 });
  }
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) return mobileJson({ error: problems.join('; ') }, { status: 503 });
    const bearerToken = typeof body.bearerToken === 'string' ? body.bearerToken.trim() : '';
    if (bearerToken.length > 8_192)
      return mobileJson({ error: 'Bearer token is too long.' }, { status: 400 });
    if (
      bearerToken &&
      [...bearerToken].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 0x1f || codePoint === 0x7f || /\s/u.test(character);
      })
    )
      return mobileJson(
        { error: 'Bearer token cannot contain whitespace or control characters.' },
        { status: 400 },
      );
    let bearerTokenEncrypted: string | null = null;
    try {
      bearerTokenEncrypted = bearerToken ? encryptMcpConnectionBearerToken(bearerToken) : null;
    } catch (error) {
      return mobileJson(
        { error: error instanceof Error ? error.message : 'Unable to protect bearer token.' },
        { status: 503 },
      );
    }
    const result = await new FirestoreMcpConnectionMutationRepository(
      getFirestoreInstallationStore(),
      config.FIRESTORE_AGENT_ID,
    ).create({ name: body.name, endpoint: body.endpoint, bearerTokenEncrypted });
    return 'error' in result
      ? mobileJson(
          { error: result.error },
          {
            status:
              result.error === 'Give this MCP connection a name.' ||
              result.error === 'Enter an HTTP or HTTPS MCP endpoint without embedded credentials.'
                ? 400
                : 409,
          },
        )
      : mobileJson(result, { status: 201 });
  }
  const result = await getApplication().addMcpConnection({
    name: body.name,
    endpoint: body.endpoint,
    bearerToken: typeof body.bearerToken === 'string' ? body.bearerToken : undefined,
  });
  return 'error' in result
    ? mobileJson(
        { error: result.error },
        { status: result.error === 'MCP connection not found.' ? 404 : 400 },
      )
    : mobileJson(result, { status: 201 });
}
