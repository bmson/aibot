import { loadConfig, resetConfigForTest } from '@assistant/config';
import { assistantModuleMetas, deploymentPlan } from '@assistant/modules/meta';
import { afterEach, describe, expect, it } from 'vitest';
import { manualStepsFor } from './manual.js';
import { blocking, runPreflight } from './preflight.js';
import { renderManualSteps, renderReport } from './report.js';
import type { CommandRunner } from './runner.js';

/** A gcloud that answers exactly what each test needs and nothing else. */
function fakeRunner(responses: Record<string, { ok?: boolean; stdout?: string }>): CommandRunner {
  return {
    run: async (command, args) => {
      const key = [command, ...args].join(' ');
      const match = Object.entries(responses).find(([prefix]) => key.startsWith(prefix));
      const response = match?.[1];
      return {
        ok: response?.ok ?? Boolean(response),
        stdout: response?.stdout ?? '',
        stderr: '',
      };
    },
  };
}

const healthyGcloud = {
  'gcloud version': { stdout: '500.0.0' },
  'gcloud auth list': { stdout: 'owner@example.com' },
  'gcloud billing projects describe': { stdout: 'true' },
  'gcloud resource-manager org-policies describe': { stdout: 'ALLOW' },
};

const completeConfig = {
  ASSISTANT_MODULES: 'reminders',
  PROD_DATABASE_URL: 'postgres://example',
  OPENROUTER_API_KEY: 'key',
  ASSISTANT_EMAIL: 'assistant@example.com',
  OWNER_EMAIL: 'owner@example.com',
};

describe('preflight', () => {
  afterEach(() => resetConfigForTest());

  it('passes for a complete configuration and a healthy project', async () => {
    const outcomes = await runPreflight({
      config: loadConfig(completeConfig),
      runner: fakeRunner(healthyGcloud),
      project: 'proj',
    });
    expect(blocking(outcomes)).toEqual([]);
    expect(blocking(outcomes)).toEqual([]);
  });

  it('blocks when billing is not linked, before anything is provisioned', async () => {
    const outcomes = await runPreflight({
      config: loadConfig(completeConfig),
      runner: fakeRunner({
        ...healthyGcloud,
        'gcloud billing projects describe': { stdout: 'false' },
      }),
      project: 'proj',
    });
    const billing = outcomes.find((outcome) => outcome.id === 'billing');
    expect(billing?.status).toBe('fail');
    expect(billing?.guidance).toContain('billing');
    expect(blocking(outcomes)).not.toEqual([]);
  });

  it('warns about an org policy that would block publishing the services', async () => {
    const outcomes = await runPreflight({
      config: loadConfig(completeConfig),
      runner: fakeRunner({
        ...healthyGcloud,
        'gcloud resource-manager org-policies describe': { stdout: 'DENY' },
      }),
      project: 'proj',
    });
    const policy = outcomes.find((outcome) => outcome.id === 'org-policy');
    expect(policy?.status).toBe('warn');
    expect(policy?.guidance).toContain('allUsers');
    // A warning explains a likely failure; it does not stop the operator.
    expect(blocking(outcomes)).toEqual([]);
  });

  it('blocks on missing settings and names them without printing values', async () => {
    const outcomes = await runPreflight({
      config: loadConfig({ ASSISTANT_MODULES: 'minimal', OPENROUTER_API_KEY: 'super-secret' }),
      runner: fakeRunner(healthyGcloud),
      project: 'proj',
    });
    const settings = outcomes.find((outcome) => outcome.id === 'settings');
    expect(settings?.status).toBe('fail');
    expect(settings?.detail).toContain('PROD_DATABASE_URL');
    expect(JSON.stringify(outcomes)).not.toContain('super-secret');
  });

  it('warns rather than blocks when an enabled module lacks its credentials', async () => {
    const outcomes = await runPreflight({
      config: loadConfig({ ...completeConfig, ASSISTANT_MODULES: 'google' }),
      runner: fakeRunner(healthyGcloud),
      project: 'proj',
    });
    const modules = outcomes.find((outcome) => outcome.id === 'modules');
    expect(modules?.status).toBe('warn');
    expect(modules?.detail).toContain('google');
    expect(blocking(outcomes)).toEqual([]);
  });

  it('fails when gcloud is absent', async () => {
    const outcomes = await runPreflight({
      config: loadConfig(completeConfig),
      runner: fakeRunner({}),
      project: '',
    });
    expect(blocking(outcomes).map((outcome) => outcome.id)).toContain('gcloud');
  });
});

describe('manual steps', () => {
  afterEach(() => resetConfigForTest());

  it('shows only the steps the composed modules need', () => {
    const steps = manualStepsFor(loadConfig({ ASSISTANT_MODULES: 'minimal' })).map(
      (step) => step.id,
    );
    expect(steps).not.toContain('oauth-consent');
    expect(steps).not.toContain('twilio-webhook');
    expect(steps).toContain('dns');
  });

  it('includes the Google and Twilio steps when those modules are enabled', () => {
    const steps = manualStepsFor(loadConfig({ ASSISTANT_MODULES: 'google,sms' })).map(
      (step) => step.id,
    );
    expect(steps).toEqual(
      expect.arrayContaining(['oauth-consent', 'bot-token', 'gmail-watch', 'twilio-webhook']),
    );
  });

  it('marks a step done once the settings it produces exist', () => {
    const steps = manualStepsFor(
      loadConfig({
        ASSISTANT_MODULES: 'google',
        GOOGLE_OAUTH_CLIENT_ID: 'id',
        GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
      }),
    );
    expect(steps.find((step) => step.id === 'oauth-consent')?.done).toBe(true);
    expect(steps.find((step) => step.id === 'bot-token')?.done).toBe(false);
  });

  it('says why each step cannot be automated', () => {
    const rendered = renderManualSteps(loadConfig({ ASSISTANT_MODULES: 'google' }));
    expect(rendered).toContain('no API');
  });
});

describe('report', () => {
  afterEach(() => resetConfigForTest());

  it('explains composition and cost before asking to provision', async () => {
    const config = loadConfig({ ...completeConfig, ASSISTANT_MODULES: 'sms,documents' });
    const outcomes = await runPreflight({
      config,
      runner: fakeRunner(healthyGcloud),
      project: 'proj',
    });
    const rendered = renderReport({
      outcomes,
      plan: deploymentPlan(config, assistantModuleMetas),
      config,
    });
    expect(rendered).toContain('Composition:');
    expect(rendered).toContain('processor');
    expect(rendered).toContain('What this costs:');
    expect(rendered).toContain('Twilio');
    expect(rendered).toContain('Manual steps');
  });
});
