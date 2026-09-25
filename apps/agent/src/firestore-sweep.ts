import { parseFirestoreEmbeddingSpace } from '@assistant/config';
import {
  dispatchOutbox,
  expireStaleApprovals,
  firestoreCodeJobUnavailable,
  getTaskQueue,
  isCodeJobEnabled,
  releaseStaleReservations,
  renotifyStalledApprovals,
  resumeResolvedApprovalTasks,
  runDueSchedules,
} from '@assistant/core';
import { FirestoreOutbox, FirestoreScheduleRepository } from '@assistant/firestore';
import type { MessageEmbeddingRepository, TaskQueue } from '@assistant/persistence';
import {
  type AgentDeps,
  agentServices,
  firestoreMaintenanceReady,
  pinnedMemoryEmbed,
} from './deps.js';
import { executorDeps } from './executor-deps.js';

export type FirestoreSweepResult =
  | { ready: false; error: string }
  | { ready: true; report: Record<string, number> };

/**
 * The single Firestore maintenance pass, shared by `/internal/sweep` and the
 * local poller so the two runtimes cannot drift apart. Each step is isolated:
 * one failure is logged and reported as zero while the rest still run. Only
 * steps that run on portable repositories are here. Module steps and ticks
 * that still need PostgreSQL are skipped until they declare themselves
 * portable.
 */
export async function runFirestoreSweep(
  deps: AgentDeps,
  options: { queue?: TaskQueue } = {},
): Promise<FirestoreSweepResult> {
  let ready = false;
  try {
    ready = await firestoreMaintenanceReady(deps);
  } catch (err) {
    console.error('Firestore maintenance readiness check failed', err);
  }
  if (!ready) return { ready: false, error: 'Firestore installation is not ready for maintenance' };

  const store = deps.firestoreStore;
  const persistence = deps.persistence;
  if (!store || persistence?.driver !== 'firestore')
    return { ready: false, error: 'Firestore maintenance persistence is unavailable' };
  let timezone: string | undefined;
  try {
    const owner = await store.doc('agents', deps.config.FIRESTORE_AGENT_ID).get();
    const configured = owner.get('timezone');
    if (
      owner.exists &&
      owner.get('id') === deps.config.FIRESTORE_AGENT_ID &&
      typeof configured === 'string' &&
      configured.trim()
    )
      timezone = configured;
  } catch (err) {
    console.error('Firestore schedule timezone read failed', err);
  }
  if (!timezone) return { ready: false, error: 'Firestore agent timezone is unavailable' };

  const step = async (name: string, fn: () => Promise<number>): Promise<number> => {
    try {
      return await fn();
    } catch (err) {
      console.error(`sweep step failed: ${name}`, err);
      return 0;
    }
  };
  const report: Record<string, number> = {
    expiredApprovalsWoke: await step(
      'expireStaleApprovals',
      async () => (await expireStaleApprovals(persistence.approvals)).length,
    ),
    resumedApprovalTasks: await step(
      'resumeResolvedApprovalTasks',
      async () => (await resumeResolvedApprovalTasks(persistence.approvals)).length,
    ),
    renotifiedApprovals: await step('renotifyStalledApprovals', () =>
      renotifyStalledApprovals(persistence, executorDeps(deps).notifyApproval),
    ),
    expiredWatches: await step('expireWatches', () =>
      persistence.watches.expire(deps.config.FIRESTORE_AGENT_ID, new Date()),
    ),
    schedulesFired: await step('runDueSchedules', async () => {
      const fired = await runDueSchedules(new FirestoreScheduleRepository(store), timezone, {
        // SQL-only jobs advance their schedule without creating a task.
        isJobEnabled: (job) => isCodeJobEnabled(job) && !firestoreCodeJobUnavailable(job),
        // Goal policy has no Firestore adapter yet. Skipping advances the goal's
        // session schedule without authorizing work. Without this, one goal row
        // would throw and starve every later schedule in the batch.
        prepareGoal: async () => ({ action: 'skip' }),
      });
      for (const item of fired)
        console.log(`schedule fired: ${item.schedule} → ${item.taskId.slice(0, 8)}`);
      return fired.length;
    }),
    // A held reservation whose task died before settling would otherwise keep
    // counting against the budget forever. PostgreSQL does this in purgeExpired.
    releasedReservations: await step('releaseStaleReservations', () =>
      releaseStaleReservations(persistence.costs, 120, 500),
    ),
    messagesEmbedded: await step('backfillMessageEmbeddings', async () => {
      const embeddings = persistence.messageEmbeddings;
      if (!embeddings) return 0;
      // Built only when a message is waiting, so an idle pass needs no model.
      return backfillFirestoreMessageEmbeddings(embeddings, (texts) =>
        pinnedMemoryEmbed(
          parseFirestoreEmbeddingSpace(deps.config.FIRESTORE_EMBEDDING_SPACE),
          persistence.modelRouting,
          (batch) => deps.router.embed(batch),
        )(texts),
      );
    }),
  };
  for (const sweepStep of deps.modules.sweepSteps) {
    if (!sweepStep.portable) continue;
    report[sweepStep.reportKey ?? sweepStep.name] = await step(sweepStep.name, () =>
      sweepStep.run(agentServices(deps)),
    );
  }
  if (deps.config.QUEUE_DRIVER === 'cloudtasks') {
    // With Cloud Tasks there is no local poller, so this scheduled sweep is
    // the only dispatcher. Every Firestore transition that makes a task
    // runnable commits a durable wake intent in the same transaction. Here the
    // intents that are due, including this pass's schedule firings and
    // approval wakes, are handed to Cloud Tasks under the stable
    // (task, generation) name, which dedupes the best-effort immediate enqueue.
    // It runs last so everything above is dispatched in the same pass.
    const tasks = deps.firestoreTasks;
    report.reclaimedTaskLeases = await step('reclaimExpiredTaskLeases', async () => {
      // Expired leases are reclaimed as a side effect of the scoped due-task
      // query. Each reclaim bumps the generation and commits a wake intent;
      // the returned rows already hold intents and need nothing further.
      if (!tasks) throw new Error('Firestore task persistence is unavailable');
      return (await tasks.findDueTasksForAgent(deps.config.FIRESTORE_AGENT_ID, 50)).length;
    });
    const dispatched = await (async () => {
      try {
        return await dispatchOutbox(new FirestoreOutbox(store), options.queue ?? getTaskQueue(), {
          batch: 50,
          concurrency: 4,
          maxDurationMs: 30_000,
        });
      } catch (err) {
        console.error('sweep step failed: dispatchWakeIntents', err);
        return null;
      }
    })();
    report.wakeIntentsDispatched = dispatched?.delivered ?? 0;
    report.wakeIntentsRetrying = dispatched?.retried ?? 0;
    report.wakeIntentErrors = dispatched ? dispatched.errors + dispatched.leaseLost : 1;
  }
  return { ready: true, report };
}

/**
 * New chat messages become recall candidates once embedded, as the PostgreSQL
 * sweep's backfill does. One bounded, newest-agnostic batch per pass; a
 * message edited mid-pass stays pending for the next one.
 */
export async function backfillFirestoreMessageEmbeddings(
  embeddings: MessageEmbeddingRepository,
  embed: (texts: string[]) => Promise<number[][]>,
  batch = 20,
): Promise<number> {
  const pending = await embeddings.pending(batch);
  if (pending.length === 0) return 0;
  const vectors = await embed(pending.map((message) => message.text.slice(0, 4000)));
  let stored = 0;
  for (const [index, message] of pending.entries()) {
    const vector = vectors[index];
    if (vector && (await embeddings.record(message.id, message.text, vector))) stored += 1;
  }
  return stored;
}
