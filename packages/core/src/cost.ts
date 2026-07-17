import {
  budgets,
  conversations,
  costEvents,
  costReservations,
  type Db,
  messages,
  rateTable,
  type SpendSource,
  tasks,
  toolCache,
} from '@assistant/db';
import { and, eq, gte, sql, sum } from 'drizzle-orm';

/**
 * Total cost governance (Phase 27): one ledger for every billable event, and
 * pre-flight reservations so expensive actions check remaining budget BEFORE
 * they start. The ceiling hierarchy is monthly > daily > per-task; hitting
 * 100% parks work as waiting_budget (never kills it mid-step), and caps
 * auto-release when their period resets.
 */

/**
 * CI wiring registry: every spend source in the schema must name where its
 * ledger rows come from. Adding a source to SPEND_SOURCES without an entry
 * here fails the cost.test.ts registry check — that failure is the point:
 * new spend categories must be wired into the ledger before they ship.
 */
export const LEDGER_WIRING: Record<SpendSource, string> = {
  model: 'ModelRouter.meter() — every model call, cost from OpenRouter usage.cost',
  embedding: 'ModelRouter.meter() — embed role, tokens × rate_table embedding_mtok',
  twilio_sms: 'sms.send tool execute — one event per delivered message',
  twilio_voice_min: 'reserved for Phase 9 voice calls (rate seeded, no caller yet)',
  cloud_run_job_sec:
    'ToolDispatcher reservation on browser.execute launch; executor reconciles at job settle',
  storage_gb_month: 'monthly GCP billing reconciliation (manual until the billing export lands)',
  external_api: 'reserved for future paid APIs (rate 0 until one exists)',
};

/** Fallbacks when the rate_table row is missing (also the seed values). */
export const DEFAULT_RATES: Record<string, { unit: string; unitPriceUsd: number }> = {
  embedding_mtok: { unit: 'mtok', unitPriceUsd: 0.02 },
  twilio_sms: { unit: 'message', unitPriceUsd: 0.0079 },
  twilio_voice_min: { unit: 'minute', unitPriceUsd: 0.014 },
  cloud_run_job_sec: { unit: 'second', unitPriceUsd: 0.00006 },
  storage_gb_month: { unit: 'gb-month', unitPriceUsd: 0.023 },
};

export async function getRate(
  db: Db,
  key: string,
): Promise<{ unit: string; unitPriceUsd: number }> {
  const [row] = await db.select().from(rateTable).where(eq(rateTable.key, key));
  if (row) return { unit: row.unit, unitPriceUsd: Number(row.unitPriceUsd) };
  const fallback = DEFAULT_RATES[key];
  if (!fallback) throw new Error(`no rate for key: ${key}`);
  return fallback;
}

export interface CostEventInput {
  source: SpendSource;
  usd: number;
  taskId?: string | null;
  toolCallId?: string | null;
  quantity?: number;
  unit?: string;
  unitPriceUsd?: number;
  description?: string;
  reservationId?: string;
  /** Also add usd to tasks.spent_usd (skip when the caller meters that itself). */
  addToTaskSpend?: boolean;
}

export async function recordCostEvent(db: Db, input: CostEventInput): Promise<void> {
  await db.insert(costEvents).values({
    source: input.source,
    taskId: input.taskId ?? undefined,
    toolCallId: input.toolCallId ?? undefined,
    quantity: input.quantity !== undefined ? input.quantity.toFixed(4) : undefined,
    unit: input.unit,
    unitPriceUsd: input.unitPriceUsd !== undefined ? input.unitPriceUsd.toFixed(8) : undefined,
    usd: input.usd.toFixed(6),
    description: input.description ?? '',
    reservationId: input.reservationId,
  });
  if (input.addToTaskSpend && input.taskId && input.usd > 0) {
    await db
      .update(tasks)
      .set({ spentUsd: sql`${tasks.spentUsd} + ${input.usd.toFixed(6)}`, updatedAt: sql`now()` })
      .where(eq(tasks.id, input.taskId));
  }
}

export interface CostTotals {
  dailySpentUsd: number;
  monthlySpentUsd: number;
  /** Estimated USD currently held by unreconciled reservations. */
  heldUsd: number;
  dailyLimitUsd: number;
  monthlyLimitUsd: number;
  softPct: number;
}

/** Spend + holds vs caps — the shared snapshot for the router guard, reservations, and the dashboard. */
export async function costTotals(db: Db): Promise<CostTotals> {
  const limits = await db.select().from(budgets);
  const limitFor = (scope: string) =>
    Number(limits.find((b) => b.scope === scope)?.limitUsd ?? Number.POSITIVE_INFINITY);

  const [daily] = await db
    .select({ total: sum(costEvents.usd) })
    .from(costEvents)
    .where(gte(costEvents.createdAt, sql`date_trunc('day', now())`));
  const [monthly] = await db
    .select({ total: sum(costEvents.usd) })
    .from(costEvents)
    .where(gte(costEvents.createdAt, sql`date_trunc('month', now())`));
  const [held] = await db
    .select({ total: sum(costReservations.estimatedUsd) })
    .from(costReservations)
    .where(eq(costReservations.status, 'held'));

  return {
    dailySpentUsd: Number(daily?.total ?? 0),
    monthlySpentUsd: Number(monthly?.total ?? 0),
    heldUsd: Number(held?.total ?? 0),
    dailyLimitUsd: limitFor('daily'),
    monthlyLimitUsd: limitFor('monthly'),
    softPct: limits.find((b) => b.scope === 'daily')?.softPct ?? 80,
  };
}

export type ReserveOutcome =
  | { ok: true; reservationId: string }
  | { ok: false; reason: string; resumeAt: Date };

/** Next daily budget reset (00:05 server time) — when parked work auto-resumes. */
export function nextDailyReset(from = new Date()): Date {
  const next = new Date(from);
  next.setHours(24, 5, 0, 0);
  return next;
}

/** Next monthly budget reset (1st, 00:05 server time). */
export function nextMonthlyReset(from = new Date()): Date {
  return new Date(from.getFullYear(), from.getMonth() + 1, 1, 0, 5, 0, 0);
}

/**
 * Pre-flight reservation against the ceiling hierarchy (monthly > daily >
 * task). Insufficient remaining budget anywhere → not ok, with the period
 * reset time the caller should park until.
 */
export async function reserveCost(
  db: Db,
  input: {
    source: SpendSource;
    estimatedUsd: number;
    taskId?: string;
    description?: string;
  },
): Promise<ReserveOutcome> {
  const totals = await costTotals(db);
  const committed = totals.heldUsd + input.estimatedUsd;

  if (totals.monthlySpentUsd + committed > totals.monthlyLimitUsd) {
    return {
      ok: false,
      reason: `monthly budget cannot cover this (spent $${totals.monthlySpentUsd.toFixed(2)} + held $${totals.heldUsd.toFixed(2)} + est $${input.estimatedUsd.toFixed(2)} > cap $${totals.monthlyLimitUsd.toFixed(2)})`,
      resumeAt: nextMonthlyReset(),
    };
  }
  if (totals.dailySpentUsd + committed > totals.dailyLimitUsd) {
    return {
      ok: false,
      reason: `daily budget cannot cover this (spent $${totals.dailySpentUsd.toFixed(2)} + held $${totals.heldUsd.toFixed(2)} + est $${input.estimatedUsd.toFixed(2)} > cap $${totals.dailyLimitUsd.toFixed(2)})`,
      resumeAt: nextDailyReset(),
    };
  }
  if (input.taskId) {
    const [task] = await db
      .select({ limit: tasks.budgetUsdLimit, spent: tasks.spentUsd })
      .from(tasks)
      .where(eq(tasks.id, input.taskId));
    if (task && Number(task.spent) + input.estimatedUsd > Number(task.limit)) {
      return {
        ok: false,
        reason: `task budget cannot cover this (spent $${Number(task.spent).toFixed(4)} + est $${input.estimatedUsd.toFixed(4)} > cap $${Number(task.limit).toFixed(4)})`,
        resumeAt: nextDailyReset(),
      };
    }
  }

  const [row] = await db
    .insert(costReservations)
    .values({
      taskId: input.taskId,
      source: input.source,
      estimatedUsd: input.estimatedUsd.toFixed(6),
      description: input.description ?? '',
    })
    .returning({ id: costReservations.id });
  if (!row) throw new Error('reservation insert failed');
  return { ok: true, reservationId: row.id };
}

/** Reconcile a held reservation to actuals: release the hold, write the ledger row. */
export async function reconcileReservation(
  db: Db,
  reservationId: string,
  actual: {
    usd: number;
    quantity?: number;
    unit?: string;
    unitPriceUsd?: number;
    toolCallId?: string;
    description?: string;
  },
): Promise<void> {
  const [reservation] = await db
    .select()
    .from(costReservations)
    .where(and(eq(costReservations.id, reservationId), eq(costReservations.status, 'held')));
  if (!reservation) return; // already reconciled/released (crash-retry safe)

  await db
    .update(costReservations)
    .set({
      status: 'reconciled',
      actualUsd: actual.usd.toFixed(6),
      reconciledAt: sql`now()`,
    })
    .where(eq(costReservations.id, reservationId));
  await recordCostEvent(db, {
    source: reservation.source as SpendSource,
    usd: actual.usd,
    taskId: reservation.taskId,
    toolCallId: actual.toolCallId,
    quantity: actual.quantity,
    unit: actual.unit,
    unitPriceUsd: actual.unitPriceUsd,
    description: actual.description ?? reservation.description,
    reservationId,
    addToTaskSpend: true,
  });
}

/** Drop a hold without a ledger entry (the action never ran). */
export async function releaseReservation(db: Db, reservationId: string): Promise<void> {
  await db
    .update(costReservations)
    .set({ status: 'released', reconciledAt: sql`now()` })
    .where(and(eq(costReservations.id, reservationId), eq(costReservations.status, 'held')));
}

// ── Threshold notifications (sweep hook) ─────────────────────────────────────

const NOTIFY_THRESHOLDS = [50, 80, 100] as const;

async function notifyOwner(db: Db, agentId: string, text: string): Promise<void> {
  const [existing] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.agentId, agentId), eq(conversations.title, 'Notifications')));
  const conversationId =
    existing?.id ??
    (
      await db
        .insert(conversations)
        .values({ agentId, channel: 'chat', trust: 'assistant', title: 'Notifications' })
        .returning()
    )[0]?.id;
  if (!conversationId) return;
  await db.insert(messages).values({
    conversationId,
    role: 'assistant',
    origin: 'assistant',
    parts: [{ type: 'text', text }],
    text,
  });
}

/**
 * Sweep hook: notify the owner once per threshold per period (50/80/100% of
 * daily and monthly caps). Dedupe rides on tool_cache keys that expire with
 * the period — no extra table for a once-a-day ping.
 */
export async function emitBudgetNotices(db: Db, agentId: string): Promise<string[]> {
  const totals = await costTotals(db);
  const emitted: string[] = [];

  const periods = [
    {
      name: 'daily' as const,
      spent: totals.dailySpentUsd,
      limit: totals.dailyLimitUsd,
      periodKey: new Date().toISOString().slice(0, 10),
      expiresAt: nextDailyReset(),
    },
    {
      name: 'monthly' as const,
      spent: totals.monthlySpentUsd,
      limit: totals.monthlyLimitUsd,
      periodKey: new Date().toISOString().slice(0, 7),
      expiresAt: nextMonthlyReset(),
    },
  ];

  for (const period of periods) {
    if (!Number.isFinite(period.limit) || period.limit <= 0) continue;
    const pct = (period.spent / period.limit) * 100;
    const crossed = [...NOTIFY_THRESHOLDS].reverse().find((t) => pct >= t);
    if (!crossed) continue;

    const cacheKey = `budget-notice:${period.name}:${crossed}:${period.periodKey}`;
    const [seen] = await db.select().from(toolCache).where(eq(toolCache.cacheKey, cacheKey));
    if (seen) continue;
    await db
      .insert(toolCache)
      .values({
        cacheKey,
        toolName: 'budget.notice',
        result: { pct: Math.round(pct) },
        expiresAt: period.expiresAt,
      })
      .onConflictDoNothing();

    const text =
      crossed >= 100
        ? `Budget: the ${period.name} cap is exhausted ($${period.spent.toFixed(2)} of $${period.limit.toFixed(2)}). Non-critical work is parked as waiting_budget and resumes when the ${period.name} period resets; owner chat keeps a small carve-out. Raise the cap on the Costs page if you want work to continue now.`
        : `Budget: ${Math.round(pct)}% of the ${period.name} cap used ($${period.spent.toFixed(2)} of $${period.limit.toFixed(2)}).`;
    await notifyOwner(db, agentId, text);
    emitted.push(cacheKey);
  }
  return emitted;
}
