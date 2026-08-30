import { isModuleEnabled, loadConfig } from '@assistant/config';
import {
  evaluateCanaryHealth,
  expireStaleApprovals,
  expireStaleSuggestions,
  findDueTasks,
  resumeResolvedApprovalTasks,
} from '@assistant/core';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { latestCanaryRun, runCanaries } from '../canaries.js';
import { agentServices, buildDeps, composedModuleMetas } from '../deps.js';
import { oidcAudienceForPath, verifyInternalAuthorization } from '../google-oidc.js';

/**
 * Queue-facing endpoints. Production accepts only a Google-signed ID token
 * from the configured internal invoker service account. Local development can
 * explicitly opt into a shared secret with INTERNAL_AUTH_MODE=shared-secret.
 */
export const internal = new Hono();

// Even though every route requires a valid invoker token, cap body size before
// JSON parsing so a compromised/misbehaving caller cannot make it a memory
// sink. Mirrors the internet-facing webhooks limit.
internal.use(
  '*',
  bodyLimit({
    maxSize: 1024 * 1024,
    onError: (c) => c.json({ error: 'request body too large' }, 413),
  }),
);

internal.use('*', async (c, next) => {
  const config = loadConfig();
  const authConfig =
    config.INTERNAL_AUTH_MODE === 'oidc'
      ? {
          ...config,
          INTERNAL_OIDC_AUDIENCE: oidcAudienceForPath(config.INTERNAL_OIDC_AUDIENCE, c.req.path),
        }
      : config;
  if (!(await verifyInternalAuthorization(c.req.header('authorization'), authConfig))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return next();
});

internal.post('/tasks/execute', async (c) => {
  const { taskId } = await c.req.json<{ taskId?: string }>().catch(() => ({ taskId: undefined }));
  if (!taskId) return c.json({ error: 'taskId required' }, 400);
  const deps = buildDeps();
  const { executeAgentTask } = await import('../task-runner.js');
  const result = await executeAgentTask(deps, taskId);
  return c.json(result);
});

internal.post('/sweep', async (c) => {
  const deps = buildDeps();
  const {
    backfillMessageEmbeddings,
    emitBudgetNotices,
    getAgent,
    getQueueNotifier,
    purgeAgedHistory,
    purgeExpired,
    renotifyStalledApprovals,
    renotifyStalledAttention,
    runDueSchedules,
  } = await import('@assistant/core');
  const { executorDeps } = await import('../executor-deps.js');
  // Each step is independent maintenance; one failing must not starve the rest
  // (a single bad schedule row used to 500 the whole endpoint and stall every
  // later reaper). Wrap each in its own guard and report what ran.
  const step = async <T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      console.error(`sweep step failed: ${name}`, err);
      return fallback;
    }
  };

  const woken = await step(
    'expireStaleApprovals',
    () => expireStaleApprovals(deps.db),
    [] as string[],
  );
  const expiredSuggestions = await step(
    'expireStaleSuggestions',
    () => expireStaleSuggestions(deps.db),
    0,
  );
  const resumedApprovalTasks = await step(
    'resumeResolvedApprovalTasks',
    () => resumeResolvedApprovalTasks(deps.db),
    [] as string[],
  );
  const renotifiedApprovals = await step(
    'renotifyStalledApprovals',
    () => renotifyStalledApprovals(deps.db, executorDeps(deps).notifyApproval),
    0,
  );
  const renotifiedAttention = await step(
    'renotifyStalledAttention',
    () => renotifyStalledAttention(deps.db, executorDeps(deps).notifyOwner),
    0,
  );
  // Guarded like every other step: this one read used to sit outside the
  // guards, so a single database blip threw the WHOLE sweep — including
  // purgeExpired below, which is what releases held cost reservations. A
  // minute-by-minute sweep that dies on a blip turns a transient fault into a
  // tightening budget.
  const agent = await step('getAgent', () => getAgent(deps.db), null);
  const fired = agent
    ? await step(
        'runDueSchedules',
        () => runDueSchedules(deps.db, agent.timezone),
        [] as Awaited<ReturnType<typeof runDueSchedules>>,
      )
    : [];
  const budgetNotices = agent
    ? await step('emitBudgetNotices', () => emitBudgetNotices(deps.db, agent.id), [] as string[])
    : [];
  // Backstop: re-notify everything due (sleep wake-ups, retries, lost notifications).
  // Locally the poller executes these itself; in prod Cloud Tasks calls back.
  const due = await step(
    'findDueTasks',
    () => findDueTasks(deps.db, 50),
    [] as Awaited<ReturnType<typeof findDueTasks>>,
  );
  const notifier = getQueueNotifier();
  for (const task of due) notifier.notify(task.id, task.queueGeneration);
  const embedded = await step(
    'backfillMessageEmbeddings',
    () => backfillMessageEmbeddings(deps.db, deps.router),
    0,
  );
  const purged = await step(
    'purgeExpired',
    () => purgeExpired(deps.db),
    null as Awaited<ReturnType<typeof purgeExpired>> | null,
  );
  const aged = await step(
    'purgeAgedHistory',
    () => purgeAgedHistory(deps.db),
    null as Awaited<ReturnType<typeof purgeAgedHistory>> | null,
  );
  // Module-declared sweep steps, in composition order, with the same per-step
  // failure isolation as the platform's own.
  const moduleSteps: Record<string, number> = {};
  for (const sweepStep of deps.modules.sweepSteps) {
    moduleSteps[sweepStep.reportKey ?? sweepStep.name] = await step(
      sweepStep.name,
      () => sweepStep.run(agentServices(deps)),
      0,
    );
  }
  return c.json({
    expiredApprovalsWoke: woken.length,
    expiredSuggestions,
    resumedApprovalTasks: resumedApprovalTasks.length,
    renotifiedApprovals,
    renotifiedAttention,
    schedulesFired: fired.length,
    dueTasksNotified: due.length,
    messagesEmbedded: embedded,
    budgetNotices: budgetNotices.length,
    ...moduleSteps,
    purged,
    aged,
  });
});

/**
 * Module-declared internal routes — usually the targets of the modules' own
 * scheduler jobs, so the schedule and the handler live in one declaration.
 * The blanket invoker-auth middleware above applies before any of these run.
 */
for (const meta of composedModuleMetas) {
  for (const route of meta.internalRoutes ?? []) {
    internal.post(route.path, async (c) => {
      if (!isModuleEnabled(loadConfig(), meta.name)) {
        const off = route.whenDisabled ?? {
          status: 404,
          body: { error: `${meta.name} module disabled` },
        };
        return c.json(off.body, off.status as ContentfulStatusCode);
      }
      const deps = buildDeps();
      const handler = deps.modules.internalHandler(route.path);
      if (!handler) return c.json({ error: `${meta.name} module disabled` }, 404);
      const response = await handler(agentServices(deps));
      if ('json' in response) {
        return c.json(response.json as object, response.status as ContentfulStatusCode);
      }
      return c.text(response.text, response.status as ContentfulStatusCode);
    });
  }
}

internal.post('/canaries/run', async (c) => {
  const config = loadConfig();
  if (!config.CANARY_ENABLED) {
    return c.json({ error: 'canaries are disabled; set CANARY_ENABLED=true explicitly' }, 503);
  }
  const result = await runCanaries(buildDeps());
  return c.json(result);
});

internal.get('/canaries/status', async (c) => {
  const latest = await latestCanaryRun(buildDeps().db);
  return c.json({ latest });
});

/**
 * Which checks in a run actually failed, and what each said.
 *
 * The alert used to carry only the verdict — "The latest canary run failed." —
 * so every red hour began with a database query to learn anything at all. The
 * run row already holds the reason; this puts it in the log line. A skipped
 * check (Twilio unconfigured, say) is not a failure and is left out.
 */
export function failedCanaryChecks(
  latest: { checks?: Record<string, unknown> } | null | undefined,
): {
  failed: string[];
  reasons: Record<string, string>;
} {
  const failed: string[] = [];
  const reasons: Record<string, string> = {};
  for (const [name, value] of Object.entries(latest?.checks ?? {})) {
    if (!value || typeof value !== 'object') continue;
    const check = value as { ok?: unknown; skipped?: unknown; detail?: unknown };
    if (check.ok === true || check.skipped === true) continue;
    failed.push(name);
    if (typeof check.detail === 'string' && check.detail) {
      reasons[name] = check.detail.slice(0, 500);
    }
  }
  return { failed, reasons };
}

internal.on(['GET', 'POST'], '/canaries/health', async (c) => {
  const latest = await latestCanaryRun(buildDeps().db);
  const health = evaluateCanaryHealth(latest);
  if (!health.ok) {
    const { failed, reasons } = failedCanaryChecks(latest);
    const line = JSON.stringify({
      msg: 'canary_alert',
      state: health.state,
      detail: health.detail,
      runId: latest?.runId,
      ...(latest?.error ? { runError: latest.error.slice(0, 500) } : {}),
      ...(failed.length > 0 ? { failed, reasons } : {}),
    });
    // A run still inside its 10-minute window is not yet news, but it used to
    // be logged NOWHERE while still answering 503 — an alert with no trace.
    if (health.state === 'running') console.warn(line);
    else console.error(line);
  }
  return c.json({ health, latest }, health.ok ? 200 : 503);
});
