import { executeTask, expireStaleApprovals, findDueTasks, loadConfig } from '@assistant/core';
import { Hono } from 'hono';
import { buildDeps } from '../deps.js';

/**
 * Queue-facing endpoints. Locally these are exercised by tests/curl with the
 * INTERNAL_API_SECRET bearer; in prod they verify Cloud Tasks / Scheduler OIDC
 * (Phase 7 swaps the auth middleware).
 */
export const internal = new Hono();

internal.use('*', async (c, next) => {
  const config = loadConfig();
  const auth = c.req.header('authorization') ?? '';
  if (auth !== `Bearer ${config.INTERNAL_API_SECRET}`) {
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
  const { backfillMessageEmbeddings, getAgent, getQueueNotifier, purgeExpired, runDueSchedules } =
    await import('@assistant/core');
  const agent = await getAgent(deps.db);
  const fired = await runDueSchedules(deps.db, agent.timezone);
  // Backstop: re-notify everything due (sleep wake-ups, retries, lost notifications).
  // Locally the poller executes these itself; in prod Cloud Tasks calls back.
  const due = await findDueTasks(deps.db, 50);
  const notifier = getQueueNotifier();
  for (const task of due) notifier.notify(task.id);
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
