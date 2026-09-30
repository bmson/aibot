import { afterEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({
  GCP_PROJECT: 'test-project',
  MOBILE_API_TOKEN: 'startup-token',
  OWNER_AUTH_MODE: 'google',
}));
vi.mock('@assistant/config', () => ({ loadConfig: () => config }));

import { clearMobileAccessTokenCache, getMobileAccessToken } from './mobile-access-token';

afterEach(() => {
  config.OWNER_AUTH_MODE = 'google';
  clearMobileAccessTokenCache();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe('mobile token refresh across Cloud Run instances', () => {
  it('uses the local configured token outside Cloud Run', async () => {
    vi.stubEnv('K_SERVICE', '');
    expect(await getMobileAccessToken()).toBe('startup-token');
  });
  it('preserves installation-specific legacy tokens alongside passkey device keys', async () => {
    vi.stubEnv('K_SERVICE', 'customer-web');
    config.OWNER_AUTH_MODE = 'passkey';
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect(await getMobileAccessToken()).toBe('startup-token');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('refreshes the latest secret on another instance after rotation', async () => {
    vi.stubEnv('K_SERVICE', 'assistant-web');
    let current = 'old-token';
    const fetcher = vi.fn(async (url: string) =>
      url.includes('metadata.google.internal')
        ? Response.json({ access_token: 'metadata-token' })
        : Response.json({ payload: { data: Buffer.from(current).toString('base64') } }),
    );
    vi.stubGlobal('fetch', fetcher);
    expect(await getMobileAccessToken()).toBe('old-token');
    current = 'new-token';
    expect(await getMobileAccessToken()).toBe('old-token');
    expect(await getMobileAccessToken(true)).toBe('new-token');
    expect(await getMobileAccessToken()).toBe('new-token');
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it('allows settings to load before a cloud token has been configured', async () => {
    vi.stubEnv('K_SERVICE', 'assistant-web');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('metadata.google.internal')
          ? Response.json({ access_token: 'metadata-token' })
          : new Response(null, { status: 404 }),
      ),
    );
    expect(await getMobileAccessToken()).toBe('');
  });
  it('does not fall back to a startup token when the secret read fails', async () => {
    vi.stubEnv('K_SERVICE', 'assistant-web');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 403 })),
    );
    await expect(getMobileAccessToken()).rejects.toThrow('credentials unavailable');
  });
});
