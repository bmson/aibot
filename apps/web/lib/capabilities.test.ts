import { type Config, loadConfig } from '@assistant/config';
import { moduleDiagnostics } from '@assistant/modules/meta';
import { describe, expect, it, vi } from 'vitest';
import {
  capabilityStatus,
  capabilityStatusTitle,
  resolveCapabilityDiagnostics,
} from './capabilities';

function cloudConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig(),
    QUEUE_DRIVER: 'cloudtasks',
    AGENT_URL: 'https://agent.example.test',
    PUBLIC_URL: 'https://agent.example.test',
    GOOGLE_OAUTH_CLIENT_ID: '',
    GOOGLE_OAUTH_CLIENT_SECRET: '',
    BOT_GOOGLE_REFRESH_TOKEN: '',
    SEARCH_PROVIDER: 'none',
    SEARCH_API_KEY: '',
    ...overrides,
  };
}

describe('capability diagnostics', () => {
  it('uses the agent environment as the source of truth in cloud deployments', async () => {
    const webConfig = cloudConfig();
    const agentConfig = cloudConfig({
      GOOGLE_OAUTH_CLIENT_ID: 'configured',
      GOOGLE_OAUTH_CLIENT_SECRET: 'configured',
      BOT_GOOGLE_REFRESH_TOKEN: 'configured',
      SEARCH_PROVIDER: 'brave',
      SEARCH_API_KEY: 'configured',
    });
    const fetcher = vi.fn(async () =>
      Response.json({ ready: true, database: 'ready', modules: moduleDiagnostics(agentConfig) }),
    ) as unknown as typeof fetch;

    const result = await resolveCapabilityDiagnostics(webConfig, fetcher);

    expect(fetcher).toHaveBeenCalledWith(
      'https://agent.example.test/ready',
      expect.objectContaining({ cache: 'no-store' }),
    );
    expect(result.statusAvailable).toBe(true);
    expect(result.diagnostics).toContainEqual({
      module: 'google',
      enabled: true,
      ready: true,
      detail: 'ready',
    });
    expect(result.diagnostics).toContainEqual({
      module: 'search',
      enabled: true,
      ready: true,
      detail: 'ready (brave)',
    });
  });

  it('reports an unavailable status instead of claiming setup is missing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetcher = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;

    const result = await resolveCapabilityDiagnostics(cloudConfig(), fetcher);
    const google = result.diagnostics.find((diagnostic) => diagnostic.module === 'google');

    expect(result.statusAvailable).toBe(false);
    expect(google).toMatchObject({
      enabled: true,
      ready: false,
      detail: 'agent readiness unavailable',
    });
    if (!google) throw new Error('missing Google diagnostic');
    expect(capabilityStatus(google, result.statusAvailable)).toBe('unavailable');
    expect(capabilityStatusTitle('unavailable')).toBe('Status unavailable');
    error.mockRestore();
  });
});
