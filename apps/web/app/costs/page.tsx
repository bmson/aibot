import { costTotals } from '@assistant/core';
import { costEvents, costReservations, modelCalls, tasks } from '@assistant/db';
import { desc, eq, gte, sql, sum } from 'drizzle-orm';
import Link from 'next/link';
import { updateCaps } from '@/app/costs/actions';
import { requireOwner } from '@/auth';
import { formatDateTime, formatUsd, truncate } from '@/lib/format';
import { getDb } from '@/lib/server';
import { btn, PageHeader } from '@/lib/ui';
import { taskTypeLabel } from '@/lib/views';

export const dynamic = 'force-dynamic';

function Bar({ spent, held, limit }: { spent: number; held: number; limit: number }) {
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const spentPct = Math.min(100, (spent / limit) * 100);
  const heldPct = Math.min(100 - spentPct, (held / limit) * 100);
  const color = spentPct >= 100 ? 'bg-red-500' : spentPct >= 80 ? 'bg-amber-500' : 'bg-blue-500';
  return (
    <div className="mt-2 flex h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
      <div className={`h-full ${color}`} style={{ width: `${spentPct}%` }} />
      <div className="h-full bg-zinc-400/60 dark:bg-zinc-500/60" style={{ width: `${heldPct}%` }} />
    </div>
  );
}

export default async function CostsPage() {
  await requireOwner();
  const db = getDb();

  const monthStart = sql`date_trunc('month', now())`;
  const [totals, bySource, byModel, topTasks, held, recent, [parkedCount]] = await Promise.all([
    costTotals(db),
    db
      .select({ source: costEvents.source, usd: sum(costEvents.usd), n: sql<number>`count(*)` })
      .from(costEvents)
      .where(gte(costEvents.createdAt, monthStart))
      .groupBy(costEvents.source)
      .orderBy(desc(sum(costEvents.usd))),
    db
      .select({ model: modelCalls.model, usd: sum(modelCalls.costUsd), n: sql<number>`count(*)` })
      .from(modelCalls)
      .where(gte(modelCalls.createdAt, monthStart))
      .groupBy(modelCalls.model)
      .orderBy(desc(sum(modelCalls.costUsd))),
    db
      .select({
        taskId: costEvents.taskId,
        usd: sum(costEvents.usd),
        type: tasks.type,
        progress: tasks.progress,
      })
      .from(costEvents)
      .innerJoin(tasks, eq(tasks.id, costEvents.taskId))
      .where(gte(costEvents.createdAt, monthStart))
      .groupBy(costEvents.taskId, tasks.type, tasks.progress)
      .orderBy(desc(sum(costEvents.usd)))
      .limit(10),
    db
      .select()
      .from(costReservations)
      .where(eq(costReservations.status, 'held'))
      .orderBy(desc(costReservations.createdAt)),
    db.select().from(costEvents).orderBy(desc(costEvents.createdAt)).limit(15),
    db.select({ n: sql<number>`count(*)` }).from(tasks).where(eq(tasks.status, 'waiting_budget')),
  ]);

  const parked = Number(parkedCount?.n ?? 0);

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Costs"
        intro={
          <>
            Every billable event in one ledger — model calls, embeddings, SMS, job runtime. Hard
            caps park new work as{' '}
            <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">waiting_budget</code> (owner
            chat keeps a carve-out); parked work resumes when the period resets.
          </>
        }
      />

      {parked > 0 ? (
        <p className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          {parked} task(s) parked waiting for budget —{' '}
          <Link href="/tasks" className="underline">
            see tasks
          </Link>{' '}
          or raise the caps below.
        </p>
      ) : null}

      {/* Burn vs caps */}
      <section className="mt-8 grid gap-4 sm:grid-cols-2">
        {(
          [
            { label: 'This month', spent: totals.monthlySpentUsd, limit: totals.monthlyLimitUsd },
            { label: 'Today', spent: totals.dailySpentUsd, limit: totals.dailyLimitUsd },
          ] as const
        ).map((p) => (
          <div key={p.label} className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
            <p className="text-xs text-zinc-500 dark:text-zinc-500">{p.label}</p>
            <p className="mt-1 text-lg font-semibold">
              {formatUsd(p.spent.toFixed(4))}
              <span className="ml-1 text-xs font-normal text-zinc-500">
                of {Number.isFinite(p.limit) ? formatUsd(p.limit.toFixed(2)) : 'no cap'}
                {totals.heldUsd > 0 ? ` (+${formatUsd(totals.heldUsd.toFixed(4))} held)` : ''}
              </span>
            </p>
            <Bar spent={p.spent} held={totals.heldUsd} limit={p.limit} />
          </div>
        ))}
      </section>

      {/* Cap editing */}
      <section className="mt-6">
        <form action={updateCaps} className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
            Daily cap (USD)
            <input
              type="number"
              name="daily"
              step="0.5"
              min="0.5"
              defaultValue={Number.isFinite(totals.dailyLimitUsd) ? totals.dailyLimitUsd : ''}
              className="w-28 rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
            Monthly cap (USD)
            <input
              type="number"
              name="monthly"
              step="1"
              min="1"
              defaultValue={Number.isFinite(totals.monthlyLimitUsd) ? totals.monthlyLimitUsd : ''}
              className="w-28 rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <button type="submit" className={btn.outline}>
            Update caps
          </button>
        </form>
      </section>

      {/* Held reservations */}
      {held.length > 0 ? (
        <section className="mt-8">
          <h2 className="text-sm font-medium">Held reservations</h2>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
            Pre-flight holds for in-flight work — released or reconciled to actuals when it settles.
          </p>
          <div className="mt-3 flex flex-col gap-2">
            {held.map((r) => (
              <div
                key={r.id}
                className="flex items-center justify-between gap-3 rounded-md border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800"
              >
                <span className="min-w-0 truncate">
                  {r.source} — {r.description || 'no description'}
                </span>
                <span className="shrink-0 text-xs text-zinc-500">
                  {formatUsd(r.estimatedUsd)} held
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* Attribution */}
      <section className="mt-8 grid gap-6 sm:grid-cols-2">
        <div>
          <h2 className="text-sm font-medium">By source (month)</h2>
          <table className="mt-3 w-full text-sm">
            <tbody>
              {bySource.map((row) => (
                <tr key={row.source} className="border-t border-zinc-100 dark:border-zinc-900">
                  <td className="py-1.5">{row.source}</td>
                  <td className="py-1.5 text-right text-xs text-zinc-500">{row.n}×</td>
                  <td className="py-1.5 text-right">{formatUsd(String(row.usd ?? '0'))}</td>
                </tr>
              ))}
              {bySource.length === 0 ? (
                <tr>
                  <td className="py-1.5 text-zinc-500">no spend yet this month</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <div>
          <h2 className="text-sm font-medium">By model (month)</h2>
          <table className="mt-3 w-full text-sm">
            <tbody>
              {byModel.map((row) => (
                <tr key={row.model} className="border-t border-zinc-100 dark:border-zinc-900">
                  <td className="max-w-0 truncate py-1.5">{row.model}</td>
                  <td className="py-1.5 text-right text-xs text-zinc-500">{row.n}×</td>
                  <td className="py-1.5 text-right">{formatUsd(String(row.usd ?? '0'))}</td>
                </tr>
              ))}
              {byModel.length === 0 ? (
                <tr>
                  <td className="py-1.5 text-zinc-500">no model calls this month</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      {/* Top tasks */}
      <section className="mt-8">
        <h2 className="text-sm font-medium">Top tasks (month)</h2>
        <div className="mt-3 flex flex-col gap-2">
          {topTasks.map((row) => (
            <Link
              key={row.taskId}
              href={`/tasks/${row.taskId}`}
              className="flex items-center justify-between gap-3 rounded-md border border-zinc-200 px-3 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
            >
              <span className="min-w-0 truncate">
                <span className="text-xs text-zinc-500">[{taskTypeLabel(row.type)}]</span>{' '}
                {truncate(row.progress || row.taskId || '', 80)}
              </span>
              <span className="shrink-0">{formatUsd(String(row.usd ?? '0'))}</span>
            </Link>
          ))}
          {topTasks.length === 0 ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">no attributed spend yet</p>
          ) : null}
        </div>
      </section>

      {/* Recent events */}
      <section className="mt-8">
        <h2 className="text-sm font-medium">Recent events</h2>
        <table className="mt-3 w-full text-sm">
          <tbody>
            {recent.map((e) => (
              <tr key={e.id} className="border-t border-zinc-100 dark:border-zinc-900">
                <td className="py-1.5 text-xs text-zinc-500 whitespace-nowrap">
                  {formatDateTime(e.createdAt)}
                </td>
                <td className="px-2 py-1.5">{e.source}</td>
                <td className="max-w-0 truncate px-2 py-1.5 text-xs text-zinc-500">
                  {e.description}
                </td>
                <td className="py-1.5 text-right">{formatUsd(e.usd)}</td>
              </tr>
            ))}
            {recent.length === 0 ? (
              <tr>
                <td className="py-1.5 text-zinc-500">the ledger is empty</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </div>
  );
}
