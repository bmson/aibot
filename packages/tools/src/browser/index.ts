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
import { type BrowserJobLauncher, isAmbiguousBrowserJobLaunchError } from './launcher.js';

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

function planUploads(plan: BrowserPlan): string[] {
  return plan.steps.flatMap((step) =>
    step.action === 'upload' && step.workspacePath ? [step.workspacePath] : [],
  );
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
        'Run an explicit browser plan (from browser.plan) in the Workspace browser — an on-demand headless Chromium job. Read-only plans (goto/waitFor/extract/screenshot/scroll) run autonomously; any interactive step (click/type/select/press/upload) requires owner approval of the exact plan. An upload may only use a Workspace path produced by drive.download. Results arrive asynchronously in the next turn. Call it ONCE and wait for the result — only one browser job can run per task at a time; parallel calls are refused. Never plan credential entry or purchases.',
      inputSchema: z.object({ plan: BrowserPlanSchema }),
      // A persisted signed-in browser profile is sensitive even for a
      // read-only plan, so it receives the same exact-plan approval as an
      // interactive browser session.
      risk: (args) =>
        isReadOnlyPlan(args.plan) && !args.plan.useProfile ? 'autonomous' : 'approval',
      // Owner workflows may inspect public web content and then use that data
      // in a browser plan. The registry strips this outward-facing tool from
      // external tasks, while the dispatcher requires exact owner approval
      // after taint has entered an owner task.
      acceptsUntrustedInput: true,
      // Phase 27: job launches reserve their worst-case runtime against the
      // budget before starting; the executor reconciles to actual seconds at settle.
      estimateCost: (args) => {
        const { plan } = args as { plan: BrowserPlan };
        return {
          source: 'cloud_run_job_sec',
          rateKey: 'cloud_run_job_sec',
          quantity: plan.maxDurationSeconds + JOB_TIMEOUT_BUFFER_SECONDS,
          description: `browser job: ${plan.goal.slice(0, 80)}`,
        };
      },
      approvalSummary: (args) => {
        const { plan } = args as { plan: BrowserPlan };
        const interactive = plan.steps.filter((s) => INTERACTIVE_ACTIONS.has(s.action));
        const hosts = planHosts(plan);
        const uploads = planUploads(plan);
        return `Browse: ${plan.goal} — ${plan.steps.length} steps (${interactive.length} interactive: ${
          [...new Set(interactive.map((s) => s.action))].join(', ') || 'none'
        })${hosts.length ? ` on ${hosts.join(', ')}` : ''}${
          uploads.length ? `; upload ${uploads.join(', ')}` : ''
        }`;
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
        if (
          !ctx.execution?.dbToolCallId ||
          !ctx.execution.modelToolCallId ||
          !ctx.stageBrowserJob ||
          !ctx.clearStagedBrowserJob
        ) {
          throw new Error('browser job launch requires a durable dispatcher execution context');
        }

        const callbackToken = randomBytes(24).toString('hex');
        const timeoutAt = new Date(
          ctx.now().getTime() + (plan.maxDurationSeconds + JOB_TIMEOUT_BUFFER_SECONDS) * 1000,
        ).toISOString();
        const pending: BrowserJobPendingResult = {
          pending: BROWSER_JOB_PENDING,
          callbackToken,
          timeoutAt,
        };
        const staged = { ...ctx.execution, pending };

        // This transactionally checkpoints both tool_calls.result and
        // tasks.state.pendingJob. Nothing external happens before it succeeds.
        await ctx.stageBrowserJob(staged);
        try {
          const { executionName } = await deps.launcher.launch({
            taskId: ctx.taskId,
            plan,
            callbackUrl: deps.callbackUrl,
            callbackToken,
          });
          await ctx
            .log('browser_job_launched', { executionName, goal: plan.goal })
            .catch((error) => console.error('browser launch log failed', error));
          return { ...pending, executionName };
        } catch (error) {
          if (isAmbiguousBrowserJobLaunchError(error)) {
            await ctx
              .log('browser_job_launch_unknown', { goal: plan.goal, error: String(error) })
              .catch((logError) => console.error('browser ambiguous-launch log failed', logError));
            // The POST may have started a job. Preserve the durable token and
            // wait for its callback/timeout; never issue a second launch.
            return pending;
          }
          // A definitive rejection means no job exists. Restore the pre-call
          // checkpoint so the dispatcher can safely record a normal failure.
          await ctx.clearStagedBrowserJob(staged);
          throw error;
        }
      },
    },
    // A logged-in browser acts on the outside world; never blanket-allowable,
    // and part of the free-range floor — an autonomy grant never auto-approves
    // an interactive/profile browser step.
    {
      outwardFacing: true,
      blanketAllowIneligible: true,
      autonomyFloor: true,
      returnsUntrustedContent: true,
      networkEgress: true,
    },
  );

  return registry;
}
