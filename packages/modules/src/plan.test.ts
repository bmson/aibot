import { loadConfig, resetConfigForTest } from '@assistant/config';
import { afterEach, describe, expect, it } from 'vitest';
import { billingSummary, deploymentPlan } from './plan.js';

const planFor = (modules: string) => deploymentPlan(loadConfig({ ASSISTANT_MODULES: modules }));

describe('deploymentPlan', () => {
  afterEach(() => resetConfigForTest());

  it('builds every worker image for a full installation', () => {
    const plan = planFor('all');
    expect(plan.workers).toEqual({ browser: true, code: true, processor: true });
    expect(plan.modules).toHaveLength(8);
  });

  it('keeps every worker key present so a disabled module is an explicit false', () => {
    const plan = planFor('minimal');
    expect(plan.workers).toEqual({ browser: false, code: false, processor: false });
    expect(plan.modules).toEqual([]);
    expect(plan.gcpApis).toEqual([]);
    expect(plan.schedulerJobs).toEqual([]);
  });

  it('collects only the infrastructure the enabled modules declare', () => {
    const plan = planFor('google');
    expect(plan.workers.processor).toBe(false);
    expect(plan.pubsubTopics).toEqual(['gmail-events']);
    expect(plan.gcpApis).toContain('gmail.googleapis.com');
    expect(plan.schedulerJobs.map((job) => job.name)).toEqual([
      'assistant-gmail-sync',
      'assistant-gmail-watch',
    ]);
    expect(plan.secretKeys).toContain('BOT_GOOGLE_REFRESH_TOKEN');
  });

  it('maps the documents module onto the processor worker image', () => {
    const plan = planFor('documents');
    expect(plan.workers).toEqual({ browser: false, code: false, processor: true });
    expect(plan.workerDetails.map((worker) => worker.dockerfile)).toEqual([
      'infra/docker/document-processor.Dockerfile',
    ]);
  });

  it('normalizes whitespace and duplicates the way the running services do', () => {
    expect(planFor('search, google , search').modules).toEqual(['google', 'search']);
  });

  it('refuses an unknown module rather than silently skipping it', () => {
    expect(() => planFor('google,unknown')).toThrow();
  });

  it('explains third-party cost before Google Cloud cost', () => {
    const summary = billingSummary(planFor('sms'));
    expect(summary).toContain('Twilio');
    expect(summary).toContain('required');
  });

  it('says plainly when modules add no cost', () => {
    expect(billingSummary(planFor('reminders'))).toBe(
      'These modules add no infrastructure or vendor cost.',
    );
  });
});
