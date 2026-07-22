import { describe, expect, it } from 'vitest';
import {
  BROWSER_JOB_PENDING,
  BrowserPlanSchema,
  hashCallbackToken,
  isBrowserJobPending,
  isReadOnlyPlan,
  planBrowse,
} from './browse.js';
import type { ModelRouter } from './model-router/router.js';

describe('hashCallbackToken', () => {
  it('is a deterministic 64-char hex digest that never echoes the raw token', () => {
    const token = 'a'.repeat(48);
    const hash = hashCallbackToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashCallbackToken(token));
    expect(hash).not.toContain(token);
  });

  it('separates distinct tokens', () => {
    expect(hashCallbackToken('token-one')).not.toBe(hashCallbackToken('token-two'));
  });
});

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

  it('rejects unknown actions', () => {
    expect(() =>
      BrowserPlanSchema.parse({
        ...readOnlyPlan,
        steps: [{ action: 'download', url: 'https://x.test' }],
      }),
    ).toThrow();
  });

  it('accepts over-long plans at the schema (planBrowse caps them post-parse)', () => {
    // maxItems was removed so the plan can be authored by the reason role; the
    // MAX_BROWSER_STEPS cap is enforced in planBrowse instead of the schema.
    const parsed = BrowserPlanSchema.parse({
      ...readOnlyPlan,
      steps: Array.from({ length: 31 }, () => ({ action: 'scroll' })),
    });
    expect(parsed.steps).toHaveLength(31);
  });

  it('accepts the search rung with a query', () => {
    const parsed = BrowserPlanSchema.parse({
      goal: 'find the current pnpm docs',
      rung: 'search',
      searchQuery: 'pnpm workspace docs',
      steps: [],
    });
    expect(parsed.rung).toBe('search');
    expect(parsed.searchQuery).toBe('pnpm workspace docs');
  });

  it('allows uploads only from the purpose-staged attachment area', () => {
    expect(() =>
      BrowserPlanSchema.parse({
        ...readOnlyPlan,
        steps: [
          ...readOnlyPlan.steps,
          {
            action: 'upload',
            selector: 'input[type=file]',
            workspacePath: 'browser/profile.tar.enc',
          },
        ],
      }),
    ).toThrow(/browser\/attachments/);
  });
});

describe('isReadOnlyPlan', () => {
  it('is true for goto/waitFor/extract/screenshot/scroll only', () => {
    expect(isReadOnlyPlan(BrowserPlanSchema.parse(readOnlyPlan))).toBe(true);
  });

  it.each(['click', 'type', 'select', 'press', 'upload'])(
    'is false when a %s step appears',
    (action) => {
      const plan = BrowserPlanSchema.parse({
        ...readOnlyPlan,
        steps: [
          ...readOnlyPlan.steps,
          {
            action,
            selector: '#x',
            text: 'q',
            value: 'v',
            key: 'Enter',
            workspacePath: 'browser/attachments/resume.pdf',
          },
        ],
      });
      expect(isReadOnlyPlan(plan)).toBe(false);
    },
  );
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
  it('parses the model output through the schema on the reason role', async () => {
    let usedRole: string | undefined;
    const router = {
      object: async (role: string) => {
        usedRole = role;
        return { ok: true, modelId: 'fake', degraded: false, object: readOnlyPlan };
      },
    } as unknown as ModelRouter;
    const plan = await planBrowse(router, { goal: 'top HN story' });
    expect(usedRole).toBe('reason');
    expect(plan.rung).toBe('headless');
    expect(plan.steps).toHaveLength(3);
  });

  it('caps an over-long plan at MAX_BROWSER_STEPS post-parse', async () => {
    const router = {
      object: async () => ({
        ok: true,
        modelId: 'fake',
        degraded: false,
        object: {
          ...readOnlyPlan,
          steps: Array.from({ length: 45 }, () => ({ action: 'scroll' })),
        },
      }),
    } as unknown as ModelRouter;
    const plan = await planBrowse(router, { goal: 'scroll forever' });
    expect(plan.steps).toHaveLength(30);
    expect(plan.rationale).toContain('truncated');
  });

  it('throws when the budget guard blocks planning', async () => {
    const router = {
      object: async () => ({ ok: false, decision: { mode: 'block', reason: 'daily cap' } }),
    } as unknown as ModelRouter;
    await expect(planBrowse(router, { goal: 'x' })).rejects.toThrow(/daily cap/);
  });
});
