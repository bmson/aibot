import { afterEach, describe, expect, it } from 'vitest';
import { gmailSyncEnabled, loadConfig, resetConfigForTest, validateProdConfig } from './config.js';

describe('config', () => {
  afterEach(() => resetConfigForTest());

  it('applies defaults', () => {
    resetConfigForTest();
    const config = loadConfig({});
    expect(config.QUEUE_DRIVER).toBe('local');
    expect(config.AGENT_PORT).toBe(8787);
    expect(config.DATABASE_URL).toContain('postgres://');
    expect(config.INTERNAL_AUTH_MODE).toBe('oidc');
    expect(config.AUTH_DEV_BYPASS).toBe(false);
    expect(config.CANARY_ENABLED).toBe(false);
    expect(config.CANARY_MAX_COST_USD).toBe(0.03);
  });

  it('parses overrides and coerces numbers', () => {
    resetConfigForTest();
    const config = loadConfig({ QUEUE_DRIVER: 'cloudtasks', AGENT_PORT: '9000' });
    expect(config.QUEUE_DRIVER).toBe('cloudtasks');
    expect(config.AGENT_PORT).toBe(9000);
  });

  it('rejects invalid driver values', () => {
    resetConfigForTest();
    expect(() => loadConfig({ QUEUE_DRIVER: 'rabbitmq' })).toThrow();
  });

  it('requires an exact opt-in for the development auth bypass', () => {
    expect(loadConfig({ AUTH_DEV_BYPASS: 'true' }).AUTH_DEV_BYPASS).toBe(true);
    resetConfigForTest();
    expect(() => loadConfig({ AUTH_DEV_BYPASS: 'yes' })).toThrow();
  });

  it('bounds and explicitly opts into real canary side effects', () => {
    expect(loadConfig({ CANARY_ENABLED: 'true', CANARY_MAX_COST_USD: '0.04' }).CANARY_ENABLED).toBe(
      true,
    );
    resetConfigForTest();
    expect(() => loadConfig({ CANARY_MAX_COST_USD: '1' })).toThrow();
  });

  it('passes prod validation for a local (default) config', () => {
    resetConfigForTest();
    expect(validateProdConfig(loadConfig({}))).toEqual([]);
  });

  it('flags a cloudtasks/oidc config missing its required keys', () => {
    resetConfigForTest();
    const config = loadConfig({
      QUEUE_DRIVER: 'cloudtasks',
      INTERNAL_AUTH_MODE: 'oidc',
      // AGENT_URL, GCP_PROJECT, INTERNAL_OIDC_* deliberately empty
    });
    const problems = validateProdConfig(config);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('AGENT_URL'),
        expect.stringContaining('GCP_PROJECT'),
        expect.stringContaining('INTERNAL_OIDC_AUDIENCE'),
        expect.stringContaining('INTERNAL_OIDC_SERVICE_ACCOUNT'),
      ]),
    );
  });

  it('is satisfied once the required cloudtasks/oidc keys are present', () => {
    resetConfigForTest();
    const config = loadConfig({
      QUEUE_DRIVER: 'cloudtasks',
      INTERNAL_AUTH_MODE: 'oidc',
      AGENT_URL: 'https://agent.example',
      GCP_PROJECT: 'proj',
      CLOUD_TASKS_QUEUE: 'agent-steps',
      INTERNAL_OIDC_AUDIENCE: 'https://agent.example',
      INTERNAL_OIDC_SERVICE_ACCOUNT: 'invoker@proj.iam.gserviceaccount.com',
      OPENROUTER_API_KEY: 'sk-or-x',
      PUBLIC_URL: 'https://agent.example',
    });
    expect(validateProdConfig(config)).toEqual([]);
  });

  it('flags an empty OpenRouter key and a still-localhost PUBLIC_URL in prod', () => {
    resetConfigForTest();
    const problems = validateProdConfig(
      loadConfig({
        QUEUE_DRIVER: 'cloudtasks',
        INTERNAL_AUTH_MODE: 'oidc',
        AGENT_URL: 'https://agent.example',
        GCP_PROJECT: 'proj',
        INTERNAL_OIDC_AUDIENCE: 'https://agent.example',
        INTERNAL_OIDC_SERVICE_ACCOUNT: 'invoker@proj.iam.gserviceaccount.com',
        // OPENROUTER_API_KEY empty; PUBLIC_URL left at the localhost default.
      }),
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('OPENROUTER_API_KEY'),
        expect.stringContaining('PUBLIC_URL'),
      ]),
    );
  });

  it('requires the Gmail push SA when a push topic is set', () => {
    resetConfigForTest();
    const problems = validateProdConfig(
      loadConfig({
        QUEUE_DRIVER: 'cloudtasks',
        INTERNAL_AUTH_MODE: 'oidc',
        AGENT_URL: 'https://agent.example',
        GCP_PROJECT: 'proj',
        INTERNAL_OIDC_AUDIENCE: 'https://agent.example',
        INTERNAL_OIDC_SERVICE_ACCOUNT: 'invoker@proj.iam.gserviceaccount.com',
        OPENROUTER_API_KEY: 'sk-or-x',
        PUBLIC_URL: 'https://agent.example',
        GMAIL_PUBSUB_TOPIC: 'projects/proj/topics/gmail',
        // GMAIL_PUSH_SERVICE_ACCOUNT deliberately empty → the 403 outage.
      }),
    );
    expect(problems).toEqual(
      expect.arrayContaining([expect.stringContaining('GMAIL_PUSH_SERVICE_ACCOUNT')]),
    );
  });
});

describe('gmailSyncEnabled', () => {
  afterEach(() => resetConfigForTest());

  it('honors an explicit true/false regardless of environment', () => {
    expect(gmailSyncEnabled(loadConfig({ GMAIL_SYNC_ENABLED: 'true' }))).toBe(true);
    resetConfigForTest();
    expect(gmailSyncEnabled(loadConfig({ GMAIL_SYNC_ENABLED: 'false' }))).toBe(false);
  });

  it('defaults on only in production when unset', () => {
    const prev = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      expect(gmailSyncEnabled(loadConfig({}))).toBe(true);
      process.env.NODE_ENV = 'development';
      expect(gmailSyncEnabled(loadConfig({}))).toBe(false);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
