import {
  evaluateCanaryHealth,
  expireStaleApprovals,
  findDueTasks,
  loadConfig,
  resumeResolvedApprovalTasks,
} from '@assistant/core';
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
  const woken = await expireStaleApprovals(deps.db);
  const resumedApprovalTasks = await resumeResolvedApprovalTasks(deps.db);
  const { renotifyStalledApprovals } = await import('@assistant/core');
  const { executorDeps } = await import('../executor-deps.js');
  const renotifiedApprovals = await renotifyStalledApprovals(
    deps.db,
    executorDeps(deps).notifyApproval,
  ).catch((err) => {
    console.error('approval re-notification sweep failed', err);
    return 0;
  });
  const {
    backfillMessageEmbeddings,
    emitBudgetNotices,
    getAgent,
    getQueueNotifier,
    purgeExpired,
    runDueSchedules,
  } = await import('@assistant/core');
  const agent = await getAgent(deps.db);
  const fired = await runDueSchedules(deps.db, agent.timezone);
  const budgetNotices = await emitBudgetNotices(deps.db, agent.id).catch((err) => {
    console.error('budget notices failed', err);
    return [] as string[];
  });
  // Backstop: re-notify everything due (sleep wake-ups, retries, lost notifications).
  // Locally the poller executes these itself; in prod Cloud Tasks calls back.
  const due = await findDueTasks(deps.db, 50);
  const notifier = getQueueNotifier();
  for (const task of due) notifier.notify(task.id, task.queueGeneration);
  const embedded = await backfillMessageEmbeddings(deps.db, deps.router).catch((err) => {
    console.error('embedding backfill failed', err);
    return 0;
  });
  const purged = await purgeExpired(deps.db);
  const { reapExpiredApplicationWatches } = await import('../application-confirmations.js');
  const expiredWatches = await reapExpiredApplicationWatches(deps).catch((err) => {
    console.error('application watch reaper failed', err);
    return 0;
  });
  const { reapExpiredWatches } = await import('../watches.js');
  const expiredInboxWatches = await reapExpiredWatches(deps).catch((err) => {
    console.error('watch reaper failed', err);
    return 0;
  });
  return c.json({
    expiredApprovalsWoke: woken.length,
    resumedApprovalTasks: resumedApprovalTasks.length,
    renotifiedApprovals,
    schedulesFired: fired.length,
    dueTasksNotified: due.length,
    messagesEmbedded: embedded,
    budgetNotices: budgetNotices.length,
    expiredWatches,
    expiredInboxWatches,
    purged,
  });
});

internal.post('/gmail/watch', async (c) => {
  const config = loadConfig();
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
