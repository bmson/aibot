import {
  backfillMessageEmbeddings,
  emitBudgetNotices,
  expireStaleApprovals,
  findDueTasks,
  getAgent,
  purgeExpired,
  renotifyStalledApprovals,
  renotifyStalledAttention,
  resumeResolvedApprovalTasks,
  runDueSchedules,
} from '@assistant/core';
import { reapExpiredApplicationWatches } from './application-confirmations.js';
import type { AgentDeps } from './deps.js';
import { syncMailbox } from './email-sync.js';
import { executorDeps } from './executor-deps.js';
import { executeAgentTask } from './task-runner.js';
import { reapExpiredWatches } from './watches.js';

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
        // Each maintenance step is independent; guard each so one failure can't
        // starve the rest (mirrors the prod /internal/sweep resilience).
        const runStep = async (name: string, fn: () => Promise<unknown>) => {
          try {
            await fn();
          } catch (err) {
            console.error(`sweep step failed: ${name}`, err);
          }
        };
        await runStep('expireStaleApprovals', async () => {
          const woken = await expireStaleApprovals(deps.db);
          if (woken.length) console.log(`sweep: expired approvals woke ${woken.length} task(s)`);
        });
        await runStep('resumeResolvedApprovalTasks', async () => {
          const resumed = await resumeResolvedApprovalTasks(deps.db);
          if (resumed.length)
            console.log(`sweep: resumed ${resumed.length} stranded approval task(s)`);
        });
        await runStep('renotifyStalledApprovals', async () => {
          const renotified = await renotifyStalledApprovals(
            deps.db,
            executorDeps(deps).notifyApproval,
          );
          if (renotified) console.log(`sweep: re-notified ${renotified} silent approval(s)`);
        });
        await runStep('renotifyStalledAttention', async () => {
          const renotified = await renotifyStalledAttention(
            deps.db,
            executorDeps(deps).notifyOwner,
          );
          if (renotified) console.log(`sweep: re-notified ${renotified} stalled task(s)`);
        });
        const agent = await getAgent(deps.db);
        await runStep('runDueSchedules', async () => {
          const fired = await runDueSchedules(deps.db, agent.timezone);
          for (const f of fired)
            console.log(`schedule fired: ${f.schedule} → ${f.taskId.slice(0, 8)}`);
        });
        await runStep('purgeExpired', () => purgeExpired(deps.db));
        await runStep('backfillMessageEmbeddings', () =>
          backfillMessageEmbeddings(deps.db, deps.router),
        );
        await runStep('emitBudgetNotices', () => emitBudgetNotices(deps.db, agent.id));
        await runStep('reapExpiredApplicationWatches', () => reapExpiredApplicationWatches(deps));
        await runStep('reapExpiredWatches', () => reapExpiredWatches(deps));
      }
      if (tick % EMAIL_SYNC_EVERY_TICKS === 0 && deps.googleClient.configured()) {
        await syncMailbox(deps).catch((err) => console.error('email-sync error', err));
      }
      const due = await findDueTasks(deps.db, 5);
      for (const task of due) {
        const result = await executeAgentTask(deps, task.id);
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
