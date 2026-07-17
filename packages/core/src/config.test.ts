import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, resetConfigForTest } from './config.js';

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
});
