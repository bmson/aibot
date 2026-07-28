import { randomBytes } from 'node:crypto';
import {
  CODE_JOB_PENDING,
  type CodeJobPendingResult,
  type CodeSpec,
  CodeSpecSchema,
} from '@assistant/core';
import { z } from 'zod';
import type { ToolRegistry } from '../registry.js';
import type { AssistantTool, ToolFlags } from '../types.js';
import { type CodeJobLauncher, isAmbiguousCodeJobLaunchError } from './launcher.js';

export * from './launcher.js';

function register<S extends z.ZodType, Out>(
  registry: ToolRegistry,
  tool: AssistantTool<S, Out>,
  flags: ToolFlags = {},
) {
  registry.register(tool as unknown as AssistantTool, flags);
}

export interface CodeDeps {
  launcher: CodeJobLauncher;
  /** POST target for the job's one-shot-token result callback. */
  callbackUrl: string;
  /**
   * True when the launcher is a genuinely isolated runtime (a Cloud Run Job
   * with no egress connector). The local child-process launcher withholds
   * credentials from the env but shares the filesystem and network, so the
   * tool must neither describe itself as a sandbox nor run autonomously for
   * anything but the owner's own untainted work.
   */
  isolated: boolean;
}

/** Extra grace on top of the script's own timeout before the sweeper gives up. */
const JOB_TIMEOUT_BUFFER_SECONDS = 120;

export function registerCodeTools(registry: ToolRegistry, deps: CodeDeps): ToolRegistry {
  register(
    registry,
    {
      name: 'code.execute',
      description:
        (deps.isolated
          ? 'Run a short script you write (JavaScript or Python) in an isolated, credential-free sandbox to compute, transform, analyze, or chart data.'
          : 'Run a short script you write (JavaScript or Python) in a local, credential-free child process to compute, transform, analyze, or chart data. This local runner is NOT a sandbox: it shares the filesystem and network with the agent.') +
        ' Python has pandas, numpy, matplotlib, and openpyxl preinstalled. Stage Workspace files into the run via `inputs` (read them at ./input/<as>); files the script writes to ./output are saved to the Workspace and listed in the result (a chart PNG, a CSV, an .xlsx). The runner has no database access and no API keys. A pure computation (no network) runs autonomously; set allowNetwork only if it truly needs the internet, which requires owner approval. Results arrive asynchronously in the next turn — call it ONCE and wait; only one job runs per task at a time. Never put secrets in the source.',
      inputSchema: z.object({ spec: CodeSpecSchema }),
      // Pure compute is autonomous; anything reaching the network needs the
      // owner. (The networkEgress flag additionally forces approval once any
      // untrusted content has entered a task — see the dispatcher's taint gate.)
      // The local child-process runner is not actually isolated, so outside an
      // owner/assistant task it always needs the owner's eyes.
      risk: (args, ctx) => {
        const spec = (args as { spec: CodeSpec }).spec;
        if (spec.allowNetwork) return 'approval';
        if (!deps.isolated && ctx.trust !== 'owner' && ctx.trust !== 'assistant') return 'approval';
        return 'autonomous';
      },
      acceptsUntrustedInput: true,
      // Reserve worst-case runtime against the budget before launch; the
      // executor reconciles to actual seconds at settle (shared Cloud Run rate).
      estimateCost: (args) => {
        const { spec } = args as { spec: CodeSpec };
        return {
          source: 'cloud_run_job_sec',
          rateKey: 'cloud_run_job_sec',
          quantity: spec.timeoutSeconds + JOB_TIMEOUT_BUFFER_SECONDS,
          description: `code job: ${spec.goal.slice(0, 80)}`,
        };
      },
      approvalSummary: (args) => {
        const { spec } = args as { spec: CodeSpec };
        const firstLine = spec.source.split('\n', 1)[0]?.slice(0, 80) ?? '';
        return `Run ${spec.language} (${spec.allowNetwork ? 'with network' : 'no network'}, ${spec.timeoutSeconds}s): ${spec.goal} — ${firstLine}`;
      },
      execute: async (args, ctx) => {
        const spec = args.spec;
        if (
          !ctx.execution?.dbToolCallId ||
          !ctx.execution.modelToolCallId ||
          !ctx.stageBrowserJob ||
          !ctx.clearStagedBrowserJob
        ) {
          throw new Error('code job launch requires a durable dispatcher execution context');
        }

        const callbackToken = randomBytes(24).toString('hex');
        const timeoutAt = new Date(
          ctx.now().getTime() + (spec.timeoutSeconds + JOB_TIMEOUT_BUFFER_SECONDS) * 1000,
        ).toISOString();
        const pending: CodeJobPendingResult = {
          pending: CODE_JOB_PENDING,
          callbackToken,
          timeoutAt,
        };
        const staged = { ...ctx.execution, pending };

        // Transactionally checkpoints tool_calls.result + tasks.state.pendingJob.
        // Nothing external happens before it succeeds. (The staging seam is shared
        // with the browser job; the sentinel value distinguishes the two.)
        await ctx.stageBrowserJob(staged);
        try {
          const { executionName } = await deps.launcher.launch({
            taskId: ctx.taskId,
            spec,
            callbackUrl: deps.callbackUrl,
            callbackToken,
          });
          await ctx
            .log('code_job_launched', { executionName, goal: spec.goal })
            .catch((error) => console.error('code launch log failed', error));
          return { ...pending, executionName };
        } catch (error) {
          if (isAmbiguousCodeJobLaunchError(error)) {
            await ctx
              .log('code_job_launch_unknown', { goal: spec.goal, error: String(error) })
              .catch((logError) => console.error('code ambiguous-launch log failed', logError));
            // The POST may have started a job. Keep the durable token and wait
            // for its callback/timeout; never issue a second launch.
            return pending;
          }
          await ctx.clearStagedBrowserJob(staged);
          throw error;
        }
      },
    },
    // Model-authored code that can reach the network acts on the outside world;
    // never blanket-allowable, and part of the free-range floor — an autonomy
    // grant never auto-approves network-enabled code. Its output may carry
    // untrusted content.
    {
      outwardFacing: true,
      blanketAllowIneligible: true,
      autonomyFloor: true,
      returnsUntrustedContent: true,
      networkEgress: true,
      // The job persists artifacts into the owner's Workspace, so external
      // (known/unknown) tasks must lose this tool along with the other
      // persistent-write capabilities — not merely the unknown tier.
      writesWorkspace: true,
    },
  );

  return registry;
}
