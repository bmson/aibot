import {
  expireStaleApprovals,
  releaseStaleReservations,
  renotifyStalledApprovals,
  resumeResolvedApprovalTasks,
  runDueSchedules,
} from '@assistant/core';
import { FirestoreScheduleRepository } from '@assistant/firestore';
import { type AgentDeps, agentServices, firestoreMaintenanceReady } from './deps.js';
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
export async function runFirestoreSweep(deps: AgentDeps): Promise<FirestoreSweepResult> {
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
      const fired = await runDueSchedules(new FirestoreScheduleRepository(store), timezone);
      for (const item of fired)
        console.log(`schedule fired: ${item.schedule} → ${item.taskId.slice(0, 8)}`);
      return fired.length;
    }),
    // A held reservation whose task died before settling would otherwise keep
    // counting against the budget forever. PostgreSQL does this in purgeExpired.
    releasedReservations: await step('releaseStaleReservations', () =>
      releaseStaleReservations(persistence.costs, 120, 500),
    ),
  };
  for (const sweepStep of deps.modules.sweepSteps) {
    if (!sweepStep.portable) continue;
    report[sweepStep.reportKey ?? sweepStep.name] = await step(sweepStep.name, () =>
      sweepStep.run(agentServices(deps)),
    );
  }
  return { ready: true, report };
}
