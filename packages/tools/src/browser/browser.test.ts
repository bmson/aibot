import type { BrowserPlan, Trust } from '@assistant/core';
import { isBrowserJobPending } from '@assistant/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../registry.js';
import type { AssistantTool, ToolContext } from '../types.js';
import {
  AmbiguousBrowserJobLaunchError,
  type BrowserJobLaunchInput,
  CloudRunJobLauncher,
  registerBrowserTools,
} from './index.js';

afterEach(() => vi.restoreAllMocks());

function makeRegistry(
  overrides: {
    plan?: BrowserPlan;
    launch?: (input: BrowserJobLaunchInput) => Promise<{ executionName?: string }>;
  } = {},
) {
  const launches: BrowserJobLaunchInput[] = [];
  const registry = registerBrowserTools(new ToolRegistry(), {
    plan: async () =>
      overrides.plan ?? {
        goal: 'g',
        rung: 'headless',
        rationale: '',
        steps: [{ action: 'goto', url: 'https://example.test' }],
        useProfile: true,
        maxDurationSeconds: 180,
      },
    launcher: {
      launch: async (input) => {
        launches.push(input);
        return overrides.launch?.(input) ?? { executionName: 'exec-1' };
      },
    },
    callbackUrl: 'http://localhost:8787/webhooks/browser/callback',
  });
  return { registry, launches };
}

function ctx(trust: Trust = 'owner', overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    taskId: 'task-1',
    agentId: 'agent-1',
    trust,
    tainted: false,
    db: {} as ToolContext['db'],
    now: () => new Date('2026-07-16T12:00:00Z'),
    signal: new AbortController().signal,
    log: vi.fn(async () => {}),
    execution: {
      dbToolCallId: 'db-call-1',
      modelToolCallId: 'model-call-1',
      toolName: 'browser.execute',
    },
    stageBrowserJob: vi.fn(async () => {}),
    clearStagedBrowserJob: vi.fn(async () => {}),
    ...overrides,
  };
}

function tool(registry: ToolRegistry, name: string): AssistantTool {
  const registered = registry.get(name);
  if (!registered) throw new Error(`${name} not registered`);
  return registered.tool;
}

const readOnlyPlan: BrowserPlan = {
  goal: 'read the front page',
  rung: 'headless',
  rationale: '',
  steps: [
    { action: 'goto', url: 'https://news.ycombinator.com' },
    { action: 'extract', what: 'titles' },
  ],
  useProfile: true,
  maxDurationSeconds: 120,
};

const interactivePlan: BrowserPlan = {
  ...readOnlyPlan,
  steps: [...readOnlyPlan.steps, { action: 'type', selector: '#q', text: 'flights' }],
};

describe('browser.execute risk tiers', () => {
  it('read-only plans are autonomous; interactive plans need approval', () => {
    const { registry } = makeRegistry();
    const risk = tool(registry, 'browser.execute').risk as (
      args: unknown,
      c: ToolContext,
    ) => string;
    expect(risk({ plan: readOnlyPlan }, ctx())).toBe('autonomous');
    expect(risk({ plan: interactivePlan }, ctx())).toBe('approval');
  });

  it('is stripped from untrusted-trigger registries and never blanket-allowable', () => {
    const { registry } = makeRegistry();
    const untrusted = registry.toolsForTask('unknown').map((t) => t.name);
    expect(untrusted).not.toContain('browser.execute');
    expect(registry.get('browser.execute')?.flags.blanketAllowIneligible).toBe(true);
  });

  it('approval summary names the goal, hosts and interactive actions', () => {
    const { registry } = makeRegistry();
    const summary = tool(registry, 'browser.execute').approvalSummary?.({
      plan: interactivePlan,
    });
    expect(summary).toContain('read the front page');
    expect(summary).toContain('news.ycombinator.com');
    expect(summary).toContain('type');
  });
});

describe('browser.execute launch', () => {
  it('launches the job and returns the pending sentinel with a timeout after the plan budget', async () => {
    const { registry, launches } = makeRegistry();
    const context = ctx();
    const result = await tool(registry, 'browser.execute').execute({ plan: readOnlyPlan }, context);
    expect(isBrowserJobPending(result)).toBe(true);
    const pending = result as { callbackToken: string; timeoutAt: string };
    expect(pending.callbackToken).toMatch(/^[0-9a-f]{48}$/);
    // 120s plan budget + 120s buffer
    expect(new Date(pending.timeoutAt).toISOString()).toBe('2026-07-16T12:04:00.000Z');
    expect(launches).toHaveLength(1);
    expect(launches[0]?.plan.goal).toBe('read the front page');
    expect(launches[0]?.callbackUrl).toBe('http://localhost:8787/webhooks/browser/callback');
    expect(context.stageBrowserJob).toHaveBeenCalledWith(
      expect.objectContaining({
        dbToolCallId: 'db-call-1',
        modelToolCallId: 'model-call-1',
        pending: expect.objectContaining({ callbackToken: pending.callbackToken }),
      }),
    );
  });

  it('durably stages the token before launch and keeps it on an ambiguous response', async () => {
    const order: string[] = [];
    const { registry, launches } = makeRegistry({
      launch: async () => {
        order.push('launch');
        throw new AmbiguousBrowserJobLaunchError('response timed out');
      },
    });
    const clear = vi.fn(async () => {});
    const context = ctx('owner', {
      stageBrowserJob: async () => {
        order.push('stage');
      },
      clearStagedBrowserJob: clear,
    });

    const result = await tool(registry, 'browser.execute').execute({ plan: readOnlyPlan }, context);
    expect(order).toEqual(['stage', 'launch']);
    expect(launches).toHaveLength(1);
    expect(isBrowserJobPending(result)).toBe(true);
    expect(clear).not.toHaveBeenCalled();
  });

  it('clears a staged intent after a definitive launch rejection', async () => {
    const { registry } = makeRegistry({
      launch: async () => {
        throw new Error('permission denied');
      },
    });
    const clear = vi.fn(async () => {});
    const context = ctx('owner', { clearStagedBrowserJob: clear });

    await expect(
      tool(registry, 'browser.execute').execute({ plan: readOnlyPlan }, context),
    ).rejects.toThrow(/permission denied/);
    expect(clear).toHaveBeenCalledOnce();
  });

  it('rejects fetch-rung plans and plans without a goto', async () => {
    const { registry } = makeRegistry();
    const execute = tool(registry, 'browser.execute').execute;
    await expect(execute({ plan: { ...readOnlyPlan, rung: 'fetch' } }, ctx())).rejects.toThrow(
      /web\.fetch/,
    );
    await expect(
      execute({ plan: { ...readOnlyPlan, steps: [{ action: 'extract' }] } }, ctx()),
    ).rejects.toThrow(/goto/);
  });
});

describe('CloudRunJobLauncher ambiguity', () => {
  it('marks a transport failure after token acquisition as an ambiguous launch', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'test-token' }), { status: 200 }),
      )
      .mockRejectedValueOnce(new TypeError('socket closed after upload'));
    const launcher = new CloudRunJobLauncher({
      project: 'test-project',
      location: 'us-central1',
      jobName: 'browser',
      storage: { driver: 'gcs', bucket: 'workspace' },
    });

    await expect(
      launcher.launch({
        taskId: 'task-1',
        plan: readOnlyPlan,
        callbackUrl: 'https://agent.test/webhooks/browser/callback',
        callbackToken: 'token',
      }),
    ).rejects.toBeInstanceOf(AmbiguousBrowserJobLaunchError);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('browser.plan', () => {
  it('returns a fetch suggestion for cheap rungs without a browser plan', async () => {
    const { registry } = makeRegistry({
      plan: {
        goal: 'g',
        rung: 'fetch',
        rationale: 'static page',
        fetchSuggestion: 'https://example.test/data',
        steps: [],
        useProfile: false,
        maxDurationSeconds: 60,
      },
    });
    const result = (await tool(registry, 'browser.plan').execute(
      { goal: 'get the data', context: '' },
      ctx(),
    )) as { browserNeeded: boolean; fetchSuggestion?: string };
    expect(result.browserNeeded).toBe(false);
    expect(result.fetchSuggestion).toBe('https://example.test/data');
  });

  it('returns the full plan for headless rungs', async () => {
    const { registry } = makeRegistry();
    const result = (await tool(registry, 'browser.plan').execute(
      { goal: 'read the page', context: '' },
      ctx(),
    )) as { browserNeeded: boolean; plan?: BrowserPlan };
    expect(result.browserNeeded).toBe(true);
    expect(result.plan?.steps.length).toBeGreaterThan(0);
  });
});
