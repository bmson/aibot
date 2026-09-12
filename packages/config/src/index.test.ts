import { afterEach, describe, expect, it } from 'vitest';
import {
  isModuleEnabled,
  loadConfig,
  parseAssistantModules,
  resetConfigForTest,
  validateProdConfig,
} from './index.js';

describe('config', () => {
  afterEach(() => resetConfigForTest());

  it('applies defaults', () => {
    const config = loadConfig({});
    expect(config.QUEUE_DRIVER).toBe('local');
    expect(config.AGENT_PORT).toBe(8787);
    expect(config.DATABASE_URL).toContain('postgres://');
    expect(config.INTERNAL_AUTH_MODE).toBe('oidc');
    expect(config.AUTH_DEV_BYPASS).toBe(false);
    expect(config.AUTH_LOCALHOST_BYPASS).toBe(false);
    expect(config.MOBILE_API_TOKEN).toBe('');
    expect(config.CANARY_ENABLED).toBe(false);
    expect(config.CANARY_MAX_COST_USD).toBe(0.03);
    expect(config.GRAPH_RAG_ENABLED).toBe(false);
    expect(config.GRAPH_SYNC_BATCH_LIMIT).toBe(25);
    expect(isModuleEnabled(config, 'google')).toBe(true);
  });

  it('parses overrides and coerces numbers', () => {
    const config = loadConfig({ QUEUE_DRIVER: 'cloudtasks', AGENT_PORT: '9000' });
    expect(config.QUEUE_DRIVER).toBe('cloudtasks');
    expect(config.AGENT_PORT).toBe(9000);
  });

  it('supports minimal and explicit module installations', () => {
    expect(parseAssistantModules('minimal')).toEqual([]);
    expect(parseAssistantModules('sms, reminders, sms')).toEqual(['sms', 'reminders']);
    expect(() => parseAssistantModules('google,unknown')).toThrow();

    const config = loadConfig({ ASSISTANT_MODULES: 'google,search' });
    expect(isModuleEnabled(config, 'google')).toBe(true);
    expect(isModuleEnabled(config, 'sms')).toBe(false);
  });

  it('rejects invalid driver and boolean values', () => {
    expect(() => loadConfig({ QUEUE_DRIVER: 'rabbitmq' })).toThrow();
    resetConfigForTest();
    expect(() => loadConfig({ AUTH_DEV_BYPASS: 'yes' })).toThrow();
    resetConfigForTest();
    expect(() => loadConfig({ AUTH_LOCALHOST_BYPASS: 'yes' })).toThrow();
  });

  it('bounds and explicitly opts into real canary side effects', () => {
    expect(loadConfig({ CANARY_ENABLED: 'true', CANARY_MAX_COST_USD: '0.04' }).CANARY_ENABLED).toBe(
      true,
    );
    resetConfigForTest();
    expect(() => loadConfig({ CANARY_MAX_COST_USD: '1' })).toThrow();
  });

  it('passes prod validation for a local config', () => {
    expect(validateProdConfig(loadConfig({}))).toEqual([]);
  });

  it('flags a cloud config missing required infrastructure', () => {
    const problems = validateProdConfig(
      loadConfig({ QUEUE_DRIVER: 'cloudtasks', INTERNAL_AUTH_MODE: 'oidc' }),
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('AGENT_URL'),
        expect.stringContaining('GCP_PROJECT'),
        expect.stringContaining('INTERNAL_OIDC_AUDIENCE'),
        expect.stringContaining('INTERNAL_OIDC_SERVICE_ACCOUNT'),
      ]),
    );
  });

  it('accepts a complete cloud config', () => {
    const config = loadConfig({
      QUEUE_DRIVER: 'cloudtasks',
      INTERNAL_AUTH_MODE: 'oidc',
      AGENT_URL: 'https://agent.example',
      GCP_PROJECT: 'proj',
      CLOUD_TASKS_QUEUE: 'agent-steps',
      INTERNAL_OIDC_AUDIENCE: 'https://agent.example',
      INTERNAL_OIDC_SERVICE_ACCOUNT: 'invoker@proj.iam.gserviceaccount.com',
      OPENROUTER_API_KEY: 'key',
      PUBLIC_URL: 'https://agent.example',
    });
    expect(validateProdConfig(config)).toEqual([]);
  });

  it('requires only the selected model provider credentials in cloud mode', () => {
    const config = loadConfig({
      QUEUE_DRIVER: 'cloudtasks',
      LLM_PROVIDER: 'vertex',
      VERTEX_PROJECT: 'customer-project',
      VERTEX_LOCATION: 'global',
    });
    expect(validateProdConfig(config).some((p) => /OPENROUTER|VERTEX/.test(p))).toBe(false);
    expect(validateProdConfig({ ...config, VERTEX_PROJECT: '', VERTEX_LOCATION: '' })).toEqual(
      expect.arrayContaining([
        expect.stringContaining('VERTEX_PROJECT'),
        expect.stringContaining('VERTEX_LOCATION'),
      ]),
    );
    expect(validateProdConfig({ ...config, LLM_PROVIDER: 'openrouter' })).toContain(
      'OPENROUTER_API_KEY is required when LLM_PROVIDER=openrouter',
    );
  });

  // Module-specific production rules moved to each module's metadata; they are
  // covered by the conformance suite in @assistant/modules.
});
