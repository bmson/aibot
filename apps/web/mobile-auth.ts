import { loadConfig } from '@assistant/config';
import { isAuthed } from './auth';
import { secureTokenMatches } from './mobile-token';

function bearerToken(request: Request): string {
  const authorization = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1]?.trim() ?? '';
}

/**
 * Native routes accept either the explicitly provisioned phone credential or
 * the existing owner web session. The latter keeps browser-based diagnostics
 * useful and lets source development use AUTH_DEV_BYPASS without inventing a
 * production bypass for the app.
 */
export async function isMobileAuthed(request: Request): Promise<boolean> {
  const configuredToken = loadConfig().MOBILE_API_TOKEN;
  if (secureTokenMatches(configuredToken, bearerToken(request))) return true;
  return Boolean(await isAuthed());
}

export function mobileUnauthorized(): Response {
  return Response.json(
    { error: 'unauthorized' },
    {
      status: 401,
      headers: {
        'cache-control': 'no-store',
        'www-authenticate': 'Bearer realm="Assistant iOS"',
      },
    },
  );
}

export function mobileJson(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('cache-control', 'no-store');
  return Response.json(value, { ...init, headers });
}
