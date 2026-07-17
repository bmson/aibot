import { describe, expect, it } from 'vitest';
import {
  BROWSER_JOB_PENDING,
  BrowserPlanSchema,
  isBrowserJobPending,
  isReadOnlyPlan,
  planBrowse,
} from './browse.js';
import type { ModelRouter } from './model-router/router.js';

const readOnlyPlan = {
  goal: 'Find the top story on Hacker News',
  rung: 'headless',
  steps: [
    { action: 'goto', url: 'https://news.ycombinator.com' },
    { action: 'waitFor', selector: '.titleline' },
    { action: 'extract', selector: '.titleline', what: 'story titles' },
  ],
};

describe('BrowserPlanSchema', () => {
  it('parses a plan and applies defaults', () => {
    const plan = BrowserPlanSchema.parse(readOnlyPlan);
    expect(plan.useProfile).toBe(false);
    expect(plan.maxDurationSeconds).toBe(180);
    expect(plan.rationale).toBe('');
  });

  it('rejects unknown actions and over-long plans', () => {
    expect(() =>
      BrowserPlanSchema.parse({
        ...readOnlyPlan,
        steps: [{ action: 'download', url: 'https://x.test' }],
      }),
    ).toThrow();
    expect(() =>
      BrowserPlanSchema.parse({
        ...readOnlyPlan,
        steps: Array.from({ length: 31 }, () => ({ action: 'scroll' })),
      }),
    ).toThrow();
  });
});

describe('isReadOnlyPlan', () => {
  it('is true for goto/waitFor/extract/screenshot/scroll only', () => {
    expect(isReadOnlyPlan(BrowserPlanSchema.parse(readOnlyPlan))).toBe(true);
  });

  it.each(['click', 'type', 'select', 'press'])('is false when a %s step appears', (action) => {
    const plan = BrowserPlanSchema.parse({
      ...readOnlyPlan,
      steps: [
        ...readOnlyPlan.steps,
        { action, selector: '#x', text: 'q', value: 'v', key: 'Enter' },
      ],
    });
    expect(isReadOnlyPlan(plan)).toBe(false);
  });
});

describe('isBrowserJobPending', () => {
  it('recognises the sentinel and nothing else', () => {
    expect(
      isBrowserJobPending({
        pending: BROWSER_JOB_PENDING,
        callbackToken: 'tok',
        timeoutAt: new Date().toISOString(),
      }),
    ).toBe(true);
    expect(isBrowserJobPending({ pending: 'something_else', callbackToken: 't' })).toBe(false);
    expect(isBrowserJobPending({ ok: true, outputs: [] })).toBe(false);
    expect(isBrowserJobPending(null)).toBe(false);
    expect(isBrowserJobPending('browser_job_pending')).toBe(false);
  });
});

describe('planBrowse', () => {
  it('parses the model output through the schema', async () => {
    const router = {
      object: async () => ({ ok: true, modelId: 'fake', degraded: false, object: readOnlyPlan }),
    } as unknown as ModelRouter;
    const plan = await planBrowse(router, { goal: 'top HN story' });
    expect(plan.rung).toBe('headless');
    expect(plan.steps).toHaveLength(3);
  });

  it('throws when the budget guard blocks planning', async () => {
    const router = {
      object: async () => ({ ok: false, decision: { mode: 'block', reason: 'daily cap' } }),
    } as unknown as ModelRouter;
    await expect(planBrowse(router, { goal: 'x' })).rejects.toThrow(/daily cap/);
  });
});
