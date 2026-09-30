import { loadConfig } from '@assistant/config';

const CACHE_MS = 30_000;
let cached: { project: string; token: string; at: number } | undefined;
let pending: Promise<string> | undefined;

export function clearMobileAccessTokenCache() {
  cached = undefined;
  pending = undefined;
}

/** Cloud Run secret environment values are snapshots taken at instance startup. */
export async function getMobileAccessToken(forceRefresh = false): Promise<string> {
  const config = loadConfig();
  if (!process.env.K_SERVICE || !config.GCP_PROJECT) return config.MOBILE_API_TOKEN;
  const project = config.GCP_PROJECT;
  if (!forceRefresh && cached?.project === project && Date.now() - cached.at < CACHE_MS)
    return cached.token;
  if (pending) return pending;
  pending = (async () => {
    const credentials = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5_000) },
    );
    if (!credentials.ok) throw new Error('Mobile token credentials unavailable');
    const { access_token } = (await credentials.json()) as { access_token: string };
    const result = await fetch(
      `https://secretmanager.googleapis.com/v1/projects/${encodeURIComponent(project)}/secrets/mobile-api-token/versions/latest:access`,
      { headers: { authorization: `Bearer ${access_token}` }, signal: AbortSignal.timeout(5_000) },
    );
    if (result.status === 404) {
      cached = { project, token: '', at: Date.now() };
      return '';
    }
    if (!result.ok) throw new Error('Mobile token unavailable');
    const body = (await result.json()) as { payload?: { data?: string } };
    if (!body.payload?.data) throw new Error('Mobile token payload unavailable');
    const token = Buffer.from(body.payload.data, 'base64').toString('utf8');
    if (!token) throw new Error('Mobile token is empty');
    cached = { project, token, at: Date.now() };
    return token;
  })();
  try {
    return await pending;
  } finally {
    pending = undefined;
  }
}
