import { type Db, knowledgeGraphSources, memories, responseChecks, tasks } from '@assistant/db';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { notifyOwnerInNotifications } from './anomaly.js';

/** A completed graph extraction may hold a five-minute lease; ten minutes is actionable. */
const STALE_GRAPH_PENDING_MS = 10 * 60 * 1000;
const QUALITY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MIN_VERIFIER_UNAVAILABLE = 2;
const MIN_CONTRACT_BLOCKS = 3;
const MIN_MUST_ACT_RETRIES = 2;
const MIN_DEGRADED_STEPS = 3;

export interface HealthMonitorResult {
  signals: string[];
  notified: boolean;
}

/**
 * Deterministic operational health checks. This intentionally does not ask a
 * model to interpret telemetry: known bad thresholds become a concise owner
 * notification. The daily schedule is also the cooldown for unresolved issues.
 */
export async function runAssistantHealthMonitor(
  deps: { db: Db; heartbeat?: () => Promise<void> },
  opts: { agentId: string; taskId?: string; now?: Date },
): Promise<HealthMonitorResult> {
  const now = opts.now ?? new Date();
  const staleBefore = new Date(now.getTime() - STALE_GRAPH_PENDING_MS);
  const qualitySince = new Date(now.getTime() - QUALITY_WINDOW_MS);
  await deps.heartbeat?.();

  const [[quarantinedRow], [stalePendingRow], [quality]] = await Promise.all([
    deps.db
      .select({ value: sql<number>`count(*)` })
      .from(knowledgeGraphSources)
      .innerJoin(memories, eq(memories.id, knowledgeGraphSources.memoryId))
      .where(
        and(eq(memories.agentId, opts.agentId), eq(knowledgeGraphSources.status, 'quarantined')),
      ),
    deps.db
      .select({ value: sql<number>`count(*)` })
      .from(knowledgeGraphSources)
      .innerJoin(memories, eq(memories.id, knowledgeGraphSources.memoryId))
      .where(
        and(
          eq(memories.agentId, opts.agentId),
          eq(knowledgeGraphSources.status, 'pending'),
          lt(knowledgeGraphSources.updatedAt, staleBefore),
        ),
      ),
    deps.db
      .select({
        verifierUnavailable: sql<number>`count(*) FILTER (WHERE ${responseChecks.outputVerificationUnavailable})`,
        contractBlocks: sql<number>`count(*) FILTER (WHERE ${responseChecks.blocked})`,
        mustActRetries: sql<number>`COALESCE(sum(${responseChecks.mustActRetries}), 0)`,
        degradedSteps: sql<number>`COALESCE(sum(${responseChecks.degradedSteps}), 0)`,
      })
      .from(responseChecks)
      .innerJoin(tasks, eq(tasks.id, responseChecks.taskId))
      .where(and(eq(tasks.agentId, opts.agentId), gte(responseChecks.createdAt, qualitySince))),
  ]);

  const quarantined = Number(quarantinedRow?.value ?? 0);
  const stalePending = Number(stalePendingRow?.value ?? 0);
  const verifierUnavailable = Number(quality?.verifierUnavailable ?? 0);
  const contractBlocks = Number(quality?.contractBlocks ?? 0);
  const mustActRetries = Number(quality?.mustActRetries ?? 0);
  const degradedSteps = Number(quality?.degradedSteps ?? 0);
  const signals = [
    quarantined > 0
      ? `${quarantined} GraphRAG source${quarantined === 1 ? '' : 's'} quarantined after bounded retries; edit the source to restart extraction.`
      : '',
    stalePending > 0
      ? `${stalePending} GraphRAG source${stalePending === 1 ? '' : 's'} stuck in a pending lease for over ten minutes.`
      : '',
    verifierUnavailable >= MIN_VERIFIER_UNAVAILABLE
      ? `final-response verification was unavailable ${verifierUnavailable} times in the last 24 hours.`
      : '',
    contractBlocks >= MIN_CONTRACT_BLOCKS
      ? `the response contract corrected or blocked ${contractBlocks} final response${contractBlocks === 1 ? '' : 's'} in the last 24 hours.`
      : '',
    mustActRetries >= MIN_MUST_ACT_RETRIES
      ? `${mustActRetries} required-action step${mustActRetries === 1 ? '' : 's'} had to be retried without a tool call in the last 24 hours.`
      : '',
    degradedSteps >= MIN_DEGRADED_STEPS
      ? `${degradedSteps} workflow step${degradedSteps === 1 ? '' : 's'} used a fallback model in the last 24 hours.`
      : '',
  ].filter((signal): signal is string => Boolean(signal));

  if (signals.length === 0) return { signals, notified: false };
  await notifyOwnerInNotifications(
    deps.db,
    opts.agentId,
    [
      '⚠️ Assistant health needs attention:',
      ...signals.map((signal) => `• ${signal}`),
      'These are deterministic checks; no configuration was changed automatically.',
    ].join('\n'),
    opts.taskId,
  );
  return { signals, notified: true };
}
