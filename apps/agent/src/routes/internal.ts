import { isModuleEnabled, loadConfig } from '@assistant/config';
import {
  evaluateCanaryHealth,
  expireStaleApprovals,
  findDueTasks,
  resumeResolvedApprovalTasks,
} from '@assistant/core';
import { gmailSyncEnabled } from '@assistant/modules/meta';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { latestCanaryRun, runCanaries } from '../canaries.js';
import { buildDeps } from '../deps.js';
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
  const agent = await getAgent(deps.db);
  const fired = await step(
    'runDueSchedules',
    () => runDueSchedules(deps.db, agent.timezone),
    [] as Awaited<ReturnType<typeof runDueSchedules>>,
  );
  const budgetNotices = await step(
    'emitBudgetNotices',
    () => emitBudgetNotices(deps.db, agent.id),
    [] as string[],
  );
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
  const expiredWatches = await step(
    'reapExpiredApplicationWatches',
    async () =>
      (await import('../application-confirmations.js')).reapExpiredApplicationWatches(deps),
    0,
  );
  const expiredInboxWatches = await step(
    'reapExpiredWatches',
    async () => (await import('../watches.js')).reapExpiredWatches(deps),
    0,
  );
  return c.json({
    expiredApprovalsWoke: woken.length,
    resumedApprovalTasks: resumedApprovalTasks.length,
    renotifiedApprovals,
    renotifiedAttention,
    schedulesFired: fired.length,
    dueTasksNotified: due.length,
    messagesEmbedded: embedded,
    budgetNotices: budgetNotices.length,
    expiredWatches,
    expiredInboxWatches,
    purged,
    aged,
  });
});

internal.post('/gmail/watch', async (c) => {
  const config = loadConfig();
  if (!isModuleEnabled(config, 'google')) {
    return c.json({ error: 'google module disabled' }, 404);
  }
  if (!config.GMAIL_PUBSUB_TOPIC) {
    return c.json(
      { error: 'GMAIL_PUBSUB_TOPIC not set — local dev uses polling; push arrives with deploy' },
      501,
    );
  }
  const deps = buildDeps();
  const { renewWatch } = await import('../email-sync.js');
  const expiration = await renewWatch(deps, config.GMAIL_PUBSUB_TOPIC);
  return c.json({ renewed: true, expiration: expiration.toISOString() });
});

internal.post('/gmail/sync', async (c) => {
  if (!gmailSyncEnabled()) {
    return c.json({ skipped: true, reason: 'gmail sync disabled by module or setting' });
  }
  const deps = buildDeps();
  const { syncMailbox } = await import('../email-sync.js');
  const result = await syncMailbox(deps);
  return c.json(result);
});

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

internal.on(['GET', 'POST'], '/canaries/health', async (c) => {
  const latest = await latestCanaryRun(buildDeps().db);
  const health = evaluateCanaryHealth(latest);
  if (!health.ok && health.state !== 'running') {
    console.error(
      JSON.stringify({
        msg: 'canary_alert',
        state: health.state,
        detail: health.detail,
        runId: latest?.runId,
      }),
    );
  }
  return c.json({ health, latest }, health.ok ? 200 : 503);
});
