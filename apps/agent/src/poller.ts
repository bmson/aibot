import {
  backfillMessageEmbeddings,
  emitBudgetNotices,
  executeTask,
  expireStaleApprovals,
  findDueTasks,
  getAgent,
  purgeExpired,
  runDueSchedules,
} from '@assistant/core';
import type { AgentDeps } from './deps.js';
import { syncMailbox } from './email-sync.js';
import { executorDeps } from './executor-deps.js';

const POLL_INTERVAL_MS = 2000;
const SWEEP_EVERY_TICKS = 150; // ~5 min, matching the prod Cloud Scheduler cadence
const EMAIL_SYNC_EVERY_TICKS = 15; // ~30s — local fallback; prod uses Pub/Sub push

/**
 * Local queue driver: polls for due tasks and executes them in-process.
 * In prod (QUEUE_DRIVER=cloudtasks) Cloud Tasks POSTs /internal/tasks/execute
 * instead and the sweeper runs on Cloud Scheduler.
 */
export function startPoller(deps: AgentDeps): () => void {
  let busy = false;
  let tick = 0;

  const interval = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      tick += 1;
      if (tick % SWEEP_EVERY_TICKS === 0) {
        const woken = await expireStaleApprovals(deps.db);
        if (woken.length) console.log(`sweep: expired approvals woke ${woken.length} task(s)`);
        const agent = await getAgent(deps.db);
        const fired = await runDueSchedules(deps.db, agent.timezone);
        for (const f of fired)
          console.log(`schedule fired: ${f.schedule} → ${f.taskId.slice(0, 8)}`);
        await purgeExpired(deps.db);
        await backfillMessageEmbeddings(deps.db, deps.router).catch((err) =>
          console.error('embedding backfill failed', err),
        );
        await emitBudgetNotices(deps.db, agent.id).catch((err) =>
          console.error('budget notices failed', err),
        );
      }
      if (tick % EMAIL_SYNC_EVERY_TICKS === 0 && deps.googleClient.configured()) {
        await syncMailbox(deps).catch((err) => console.error('email-sync error', err));
      }
      const due = await findDueTasks(deps.db, 5);
      for (const task of due) {
        const result = await executeTask(executorDeps(deps), task.id);
        if (result.outcome !== 'not_claimable') {
          console.log(`task ${task.id.slice(0, 8)} [${task.type}] → ${result.outcome}`);
        }
      }
    } catch (err) {
      console.error('poller error', err);
    } finally {
      busy = false;
    }
  }, POLL_INTERVAL_MS);

  return () => clearInterval(interval);
}
