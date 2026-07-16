import { randomBytes } from 'node:crypto';
import {
  BROWSER_JOB_PENDING,
  type BrowserJobPendingResult,
  type BrowserPlan,
  BrowserPlanSchema,
  INTERACTIVE_ACTIONS,
  isReadOnlyPlan,
} from '@assistant/core';
import { z } from 'zod';
import type { ToolRegistry } from '../registry.js';
import type { AssistantTool, ToolFlags } from '../types.js';
import type { BrowserJobLauncher } from './launcher.js';

export * from './launcher.js';

function register<S extends z.ZodType, Out>(
  registry: ToolRegistry,
  tool: AssistantTool<S, Out>,
  flags: ToolFlags = {},
) {
  registry.register(tool as unknown as AssistantTool, flags);
}

export interface BrowserDeps {
  /** Escalation-ladder planner (core's planBrowse, injected to avoid a cycle). */
  plan: (input: { goal: string; context?: string; taskId?: string }) => Promise<BrowserPlan>;
  launcher: BrowserJobLauncher;
  /** POST target for the job's one-shot-token result callback. */
  callbackUrl: string;
}

/** Extra grace on top of the plan's own budget before the sweeper gives up on the job. */
const JOB_TIMEOUT_BUFFER_SECONDS = 120;

function planHosts(plan: BrowserPlan): string[] {
  const hosts = new Set<string>();
  for (const step of plan.steps) {
    if (step.action === 'goto' && step.url) {
      try {
        hosts.add(new URL(step.url).hostname);
      } catch {
        // non-URL goto targets surface in the plan text itself
      }
    }
  }
  return [...hosts];
}

export function registerBrowserTools(registry: ToolRegistry, deps: BrowserDeps): ToolRegistry {
  register(registry, {
    name: 'browser.plan',
    description:
      'Plan how to get something from the web using the escalation ladder (API → HTTP fetch → parse → headless browser → visual). Returns either a URL for web.fetch (cheaper rungs) or an explicit browser step plan to pass to browser.execute. Planning only — nothing runs.',
    inputSchema: z.object({
      goal: z.string().min(3).max(500),
      context: z.string().max(4000).default(''),
    }),
    risk: 'autonomous',
    acceptsUntrustedInput: true,
    execute: async (args, ctx) => {
      const plan = await deps.plan({
        goal: args.goal,
        context: args.context || undefined,
        taskId: ctx.taskId,
      });
      if (plan.rung === 'api' || plan.rung === 'fetch' || plan.rung === 'parse') {
        return {
          browserNeeded: false,
          rung: plan.rung,
          rationale: plan.rationale,
          fetchSuggestion: plan.fetchSuggestion,
          note: 'No browser needed — call web.fetch with fetchSuggestion instead.',
        };
      }
      return {
        browserNeeded: true,
        plan,
        note: isReadOnlyPlan(plan)
          ? 'Read-only plan — pass it to browser.execute; it runs without approval.'
          : 'Plan contains interactive steps — browser.execute will ask the owner to approve the exact plan first.',
      };
    },
  });

  register(
    registry,
    {
      name: 'browser.execute',
      description:
        'Run an explicit browser plan (from browser.plan) in the Workspace browser — an on-demand headless Chromium job. Read-only plans (goto/waitFor/extract/screenshot/scroll) run autonomously; any interactive step (click/type/select/press) requires owner approval of the exact plan. Results arrive asynchronously in the next turn. Never plan credential entry or purchases.',
      inputSchema: z.object({ plan: BrowserPlanSchema }),
      risk: (args) => (isReadOnlyPlan(args.plan) ? 'autonomous' : 'approval'),
      acceptsUntrustedInput: false,
      approvalSummary: (args) => {
        const { plan } = args as { plan: BrowserPlan };
        const interactive = plan.steps.filter((s) => INTERACTIVE_ACTIONS.has(s.action));
        const hosts = planHosts(plan);
        return `Browse: ${plan.goal} — ${plan.steps.length} steps (${interactive.length} interactive: ${
          [...new Set(interactive.map((s) => s.action))].join(', ') || 'none'
        })${hosts.length ? ` on ${hosts.join(', ')}` : ''}`;
      },
      execute: async (args, ctx) => {
        const plan = args.plan;
        if (plan.rung !== 'headless' && plan.rung !== 'visual') {
          throw new Error(
            `plan rung is "${plan.rung}" — no browser needed; use web.fetch with the plan's fetchSuggestion`,
          );
        }
        if (plan.steps.length === 0) throw new Error('plan has no steps');
        if (!plan.steps.some((s) => s.action === 'goto' && s.url)) {
          throw new Error('plan must start from a goto step with a URL');
        }

        const callbackToken = randomBytes(24).toString('hex');
        const timeoutAt = new Date(
          ctx.now().getTime() + (plan.maxDurationSeconds + JOB_TIMEOUT_BUFFER_SECONDS) * 1000,
        ).toISOString();
        const { executionName } = await deps.launcher.launch({
          taskId: ctx.taskId,
          plan,
          callbackUrl: deps.callbackUrl,
          callbackToken,
        });
        await ctx.log('browser_job_launched', { executionName, goal: plan.goal });

        const pending: BrowserJobPendingResult = {
          pending: BROWSER_JOB_PENDING,
          callbackToken,
          timeoutAt,
          executionName,
        };
        return pending;
      },
    },
    // A logged-in browser acts on the outside world; never blanket-allowable.
    { outwardFacing: true, blanketAllowIneligible: true },
  );

  return registry;
}
