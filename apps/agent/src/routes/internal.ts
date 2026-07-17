import { executeTask, expireStaleApprovals, findDueTasks, loadConfig } from '@assistant/core';
import { Hono } from 'hono';
import { buildDeps } from '../deps.js';
import { oidcAudienceForPath, verifyInternalAuthorization } from '../google-oidc.js';

/**
 * Queue-facing endpoints. Production accepts only a Google-signed ID token
 * from the configured internal invoker service account. Local development can
 * explicitly opt into a shared secret with INTERNAL_AUTH_MODE=shared-secret.
 */
export const internal = new Hono();

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
  const { executorDeps } = await import('../executor-deps.js');
  const result = await executeTask(executorDeps(deps), taskId);
  return c.json(result);
});

internal.post('/sweep', async (c) => {
  const deps = buildDeps();
  const woken = await expireStaleApprovals(deps.db);
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
  return c.json({
    expiredApprovalsWoke: woken.length,
    schedulesFired: fired.length,
    dueTasksNotified: due.length,
    messagesEmbedded: embedded,
    budgetNotices: budgetNotices.length,
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
