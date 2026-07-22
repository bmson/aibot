import {
  type AnomalyRow,
  agents,
  anomalies,
  approvalPolicies,
  conversations,
  type Db,
  messages,
  toolCalls,
} from '@assistant/db';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';

/**
 * Approval anomaly detection (Phase 18). A nightly scan over auto-executed,
 * policy-matched tool calls flags three risk shapes on the risk-#10 surface:
 *
 *  - burst      — many auto-executions of one policy inside a short window;
 *  - frequency  — a policy's 24h auto-exec count far above its trailing baseline;
 *  - off_hours  — an outward-facing action auto-executed in the small hours.
 *
 * Each anomaly cites the triggering tool_calls. Dedup is by (kind, subject,
 * window), so a re-scan never double-reports and dismissing a window keeps it
 * dismissed; for frequency, a dismissed observation also raises the baseline so
 * the same level stops re-flagging on later days. Suspend reuses the existing
 * approval_policies.enabled flag — a suspended policy stops matching, so its
 * actions fall back to manual approval (never a silent continue).
 */

const LOOKBACK_HOURS = 24;
const BURST_WINDOW_MS = 10 * 60 * 1000;
const BURST_MIN = 5;
const FREQ_MULT = 3;
const FREQ_MIN_COUNT = 5;
const FREQ_BASELINE_DAYS = 7;
const OFF_HOUR_START_UTC = 0;
const OFF_HOUR_END_UTC = 6;
const MAX_CITATIONS = 25;

/**
 * Outward-reaching tools (approximate — third-party-facing sends/shares). Used
 * only by the off-hours heuristic; kept in sync by hand since the code job has
 * no access to the tools registry.
 */
const OUTWARD_TOOLS: ReadonlySet<string> = new Set([
  'gmail.send',
  'calendar.create_event',
  'docs.share',
  'sheets.append_rows',
  'sheets.write_rows',
  'slides.append',
]);

interface AutoExec {
  id: string;
  toolName: string;
  policyId: string;
  createdAt: Date;
}

export interface AnomalyScanResult {
  flagged: number;
  byKind: Record<string, number>;
}

function dayLabel(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The densest BURST_WINDOW_MS window; returns its members when it reaches BURST_MIN. */
function detectBurst(rows: AutoExec[]): { ids: string[]; windowStart: Date } | null {
  const sorted = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  let best: { ids: string[]; windowStart: Date } | null = null;
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i] as AutoExec;
    const end = start.createdAt.getTime() + BURST_WINDOW_MS;
    const inWindow = sorted.slice(i).filter((r) => r.createdAt.getTime() <= end);
    if (inWindow.length >= BURST_MIN && (!best || inWindow.length > best.ids.length)) {
      best = { ids: inWindow.map((r) => r.id), windowStart: start.createdAt };
    }
  }
  return best;
}

interface PendingAnomaly {
  kind: 'burst' | 'frequency' | 'off_hours';
  policyId: string;
  toolName: string;
  observed: number;
  expected: number;
  toolCallIds: string[];
  detail: string;
  windowLabel: string;
  subjectKey: string;
}

/** Run the nightly anomaly scan for the (single) agent, inserting new anomalies and alerting the owner. */
export async function runAnomalyScan(
  deps: { db: Db; heartbeat?: () => Promise<void> },
  opts: { taskId?: string; now?: Date } = {},
): Promise<AnomalyScanResult> {
  const { db } = deps;
  const now = opts.now ?? new Date();
  await deps.heartbeat?.();

  const [agent] = await db.select({ id: agents.id }).from(agents).limit(1);
  if (!agent) return { flagged: 0, byKind: {} };
  const agentId = agent.id;

  const policies = await db
    .select({ id: approvalPolicies.id, toolName: approvalPolicies.toolName })
    .from(approvalPolicies)
    .where(eq(approvalPolicies.agentId, agentId));
  if (policies.length === 0) return { flagged: 0, byKind: {} };
  const policyById = new Map(policies.map((p) => [p.id, p]));

  const baselineStart = new Date(now.getTime() - (FREQ_BASELINE_DAYS + 1) * 24 * 3600 * 1000);
  const windowStart = new Date(now.getTime() - LOOKBACK_HOURS * 3600 * 1000);

  const rows = await db
    .select({
      id: toolCalls.id,
      toolName: toolCalls.toolName,
      createdAt: toolCalls.createdAt,
      policyId: sql<string | null>`${toolCalls.decision}->>'policyId'`,
    })
    .from(toolCalls)
    .where(
      and(
        eq(toolCalls.risk, 'autonomous'),
        inArray(toolCalls.status, ['succeeded', 'executing']),
        gte(toolCalls.createdAt, baselineStart),
        sql`${toolCalls.decision}->>'policyId' is not null`,
      ),
    );
  const scoped: AutoExec[] = rows
    .filter((r) => r.policyId !== null && policyById.has(r.policyId))
    .map((r) => ({
      id: r.id,
      toolName: r.toolName,
      policyId: r.policyId as string,
      createdAt: r.createdAt,
    }));

  // Dismissed frequency observations raise the floor for that policy.
  const dismissed = await db
    .select({ policyId: anomalies.policyId, observed: anomalies.observed })
    .from(anomalies)
    .where(
      and(
        eq(anomalies.agentId, agentId),
        eq(anomalies.kind, 'frequency'),
        eq(anomalies.status, 'dismissed'),
      ),
    );
  const dismissedFloor = new Map<string, number>();
  for (const d of dismissed) {
    if (!d.policyId) continue;
    dismissedFloor.set(d.policyId, Math.max(dismissedFloor.get(d.policyId) ?? 0, d.observed));
  }

  const byPolicy = new Map<string, AutoExec[]>();
  for (const row of scoped) {
    const list = byPolicy.get(row.policyId) ?? [];
    list.push(row);
    byPolicy.set(row.policyId, list);
  }

  const pending: PendingAnomaly[] = [];
  for (const [policyId, all] of byPolicy) {
    const policy = policyById.get(policyId);
    if (!policy) continue;
    const recent = all.filter((r) => r.createdAt.getTime() >= windowStart.getTime());
    if (recent.length === 0) continue;

    // burst — a dense cluster in the last 24h
    const burst = detectBurst(recent);
    if (burst) {
      pending.push({
        kind: 'burst',
        policyId,
        toolName: policy.toolName,
        observed: burst.ids.length,
        expected: BURST_MIN,
        toolCallIds: burst.ids.slice(0, MAX_CITATIONS),
        detail: `${burst.ids.length} auto-executions of ${policy.toolName} within ${BURST_WINDOW_MS / 60000} minutes`,
        windowLabel: burst.windowStart.toISOString().slice(0, 16),
        subjectKey: policyId,
      });
    }

    // frequency — today's count far above the trailing daily baseline
    const prior = all.filter((r) => r.createdAt.getTime() < windowStart.getTime());
    const baseline = prior.length / FREQ_BASELINE_DAYS;
    const threshold = Math.max(
      FREQ_MIN_COUNT,
      Math.ceil(baseline * FREQ_MULT),
      dismissedFloor.get(policyId) ?? 0,
    );
    if (recent.length > threshold) {
      pending.push({
        kind: 'frequency',
        policyId,
        toolName: policy.toolName,
        observed: recent.length,
        expected: threshold,
        toolCallIds: recent.slice(-MAX_CITATIONS).map((r) => r.id),
        detail: `${policy.toolName} auto-executed ${recent.length}× in 24h (baseline ~${baseline.toFixed(1)}/day, threshold ${threshold})`,
        windowLabel: dayLabel(now),
        subjectKey: policyId,
      });
    }

    // off_hours — an outward-facing action auto-executed overnight (UTC)
    const offHours = recent.filter((r) => {
      const h = r.createdAt.getUTCHours();
      return OUTWARD_TOOLS.has(r.toolName) && h >= OFF_HOUR_START_UTC && h < OFF_HOUR_END_UTC;
    });
    if (offHours.length > 0) {
      pending.push({
        kind: 'off_hours',
        policyId,
        toolName: policy.toolName,
        observed: offHours.length,
        expected: 0,
        toolCallIds: offHours.map((r) => r.id).slice(0, MAX_CITATIONS),
        detail: `${offHours.length} outward-facing ${policy.toolName} auto-execution(s) between 00:00–06:00 UTC`,
        windowLabel: dayLabel(now),
        subjectKey: policyId,
      });
    }
  }

  if (pending.length === 0) return { flagged: 0, byKind: {} };

  await deps.heartbeat?.();
  const inserted = await db
    .insert(anomalies)
    .values(pending.map((p) => ({ agentId, ...p })))
    .onConflictDoNothing({
      target: [anomalies.agentId, anomalies.kind, anomalies.subjectKey, anomalies.windowLabel],
    })
    .returning();

  const byKind: Record<string, number> = {};
  for (const a of inserted) byKind[a.kind] = (byKind[a.kind] ?? 0) + 1;

  if (inserted.length > 0) {
    const lines = inserted.map((a) => `• ${a.detail}`);
    await notifyOwnerInNotifications(
      db,
      agentId,
      [
        `⚠️ ${inserted.length} approval ${inserted.length === 1 ? 'anomaly' : 'anomalies'} detected:`,
        ...lines,
        'Review or suspend the policy on the [Anomalies page](/anomalies).',
      ].join('\n'),
      opts.taskId,
    );
  }

  return { flagged: inserted.length, byKind };
}

/** Post a message into the owner's Notifications conversation (mirrors owner.notify). */
export async function notifyOwnerInNotifications(
  db: Db,
  agentId: string,
  text: string,
  taskId?: string,
): Promise<void> {
  const [existing] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.agentId, agentId), eq(conversations.title, 'Notifications')));
  let conversationId = existing?.id;
  if (!conversationId) {
    const [created] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'assistant', title: 'Notifications' })
      .returning({ id: conversations.id });
    conversationId = created?.id;
  }
  if (!conversationId) return;
  await db.insert(messages).values({
    conversationId,
    taskId: taskId ?? null,
    role: 'assistant',
    origin: 'assistant',
    parts: [{ type: 'text', text }],
    text,
  });
}

// ── Dashboard operations ─────────────────────────────────────────────────────

/** Open anomalies, newest first, for the Anomalies panel. */
export async function listOpenAnomalies(db: Db, agentId: string): Promise<AnomalyRow[]> {
  return db
    .select()
    .from(anomalies)
    .where(and(eq(anomalies.agentId, agentId), eq(anomalies.status, 'open')))
    .orderBy(desc(anomalies.createdAt))
    .limit(100);
}

/** Dismiss an anomaly (false positive) — raises the effective baseline for frequency. */
export async function dismissAnomaly(db: Db, anomalyId: string): Promise<void> {
  await db
    .update(anomalies)
    .set({ status: 'dismissed', updatedAt: sql`now()` })
    .where(eq(anomalies.id, anomalyId));
}

/**
 * Suspend the policy behind an anomaly: disable it (so it stops matching and its
 * actions fall back to manual approval) and mark the anomaly acted-on.
 */
export async function suspendAnomalyPolicy(
  db: Db,
  anomalyId: string,
): Promise<{ suspended: boolean }> {
  const [anomaly] = await db.select().from(anomalies).where(eq(anomalies.id, anomalyId));
  if (!anomaly) return { suspended: false };
  if (anomaly.policyId) {
    await db
      .update(approvalPolicies)
      .set({ enabled: false, updatedAt: sql`now()` })
      .where(eq(approvalPolicies.id, anomaly.policyId));
  }
  await db
    .update(anomalies)
    .set({ status: 'suspended', updatedAt: sql`now()` })
    .where(eq(anomalies.id, anomalyId));
  return { suspended: Boolean(anomaly.policyId) };
}
