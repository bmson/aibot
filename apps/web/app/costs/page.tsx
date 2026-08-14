import { getCostsDashboard } from '@assistant/application/costs';
import Link from 'next/link';
import { updateCaps } from '@/app/costs/actions';
import { requireOwner } from '@/auth';
import { formatDateTime, formatUsd, truncate } from '@/lib/format';
import { getDb } from '@/lib/server';
import { cardShellClass, InfoGrid, InfoItem, inputClass, PageHeader, PageShell } from '@/lib/ui';
import { SubmitButton } from '@/lib/ui-client';
import { taskTypeLabel } from '@/lib/views';

export const metadata = { title: 'Costs' };

export const dynamic = 'force-dynamic';

function Bar({ spent, held, limit }: { spent: number; held: number; limit: number }) {
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const spentPct = Math.min(100, (spent / limit) * 100);
  const heldPct = Math.min(100 - spentPct, (held / limit) * 100);
  const color = spentPct >= 100 ? 'bg-red-500' : spentPct >= 80 ? 'bg-amber-500' : 'bg-accent';
  return (
    <div className="mt-2 flex h-2 w-full overflow-hidden rounded-full bg-sunken">
      <div className={`h-full ${color}`} style={{ width: `${spentPct}%` }} />
      <div className="h-full bg-muted/50" style={{ width: `${heldPct}%` }} />
    </div>
  );
}

export default async function CostsPage() {
  await requireOwner();
  const db = getDb();
  const {
    timezone: tz,
    totals,
    bySource,
    byModel,
    topTasks,
    held,
    recent,
    parkedTasks: parked,
    taskDefaultLimit,
  } = await getCostsDashboard(db);

  return (
    <PageShell size="reading">
      <PageHeader
        title="Costs"
        intro="See what the assistant has spent and set limits that keep costs under control."
      />

      {parked > 0 ? (
        <p className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          {parked} {parked === 1 ? 'task is' : 'tasks are'} paused because a spending limit was
          reached —{' '}
          <Link href="/tasks" className="underline">
            see tasks
          </Link>{' '}
          or adjust the limits below.
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
          <div key={p.label} className={`${cardShellClass} p-4`}>
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-[13px] font-semibold text-strong">{p.label}</p>
              <p className="font-display text-2xl font-semibold tracking-[-0.04em] tabular-nums">
                {formatUsd(p.spent.toFixed(4))}
              </p>
            </div>
            <Bar spent={p.spent} held={totals.heldUsd} limit={p.limit} />
            <InfoGrid className="mt-3">
              <InfoItem label="Limit">
                {Number.isFinite(p.limit) ? formatUsd(p.limit.toFixed(2)) : 'No cap'}
              </InfoItem>
              <InfoItem label="Reserved">{formatUsd(totals.heldUsd.toFixed(4))}</InfoItem>
            </InfoGrid>
          </div>
        ))}
      </section>

      {/* Cap editing */}
      <section className="mt-6">
        <form action={updateCaps} className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            Default task cap (USD)
            <input
              type="number"
              name="task_default"
              step="0.05"
              min="0.05"
              defaultValue={taskDefaultLimit ? Number(taskDefaultLimit) : ''}
              className={`${inputClass} w-28`}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            Daily cap (USD)
            <input
              type="number"
              name="daily"
              step="0.5"
              min="0.5"
              defaultValue={Number.isFinite(totals.dailyLimitUsd) ? totals.dailyLimitUsd : ''}
              className={`${inputClass} w-28`}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            Monthly cap (USD)
            <input
              type="number"
              name="monthly"
              step="1"
              min="1"
              defaultValue={Number.isFinite(totals.monthlyLimitUsd) ? totals.monthlyLimitUsd : ''}
              className={`${inputClass} w-28`}
            />
          </label>
          {/* Full width on a phone so it lands on its own row instead of
              trailing whichever cap field happened to wrap last. */}
          <SubmitButton variant="outline" pendingLabel="Updating…" className="w-full sm:w-auto">
            Update caps
          </SubmitButton>
        </form>
      </section>

      <details className="mt-8 rounded-2xl bg-sunken/55">
        <summary className="disclosure flex items-center gap-2 cursor-pointer px-5 py-4 text-sm font-medium">
          Detailed usage
        </summary>
        <div className="border-t border-edge px-5 pb-5">
          {held.length > 0 ? (
            <section className="mt-5">
              <h2 className="text-sm font-medium">In-progress work</h2>
              <p className="mt-1 text-xs text-muted">
                Estimated costs reserved for work that has not finished yet.
              </p>
              <div className="mt-3 flex flex-col gap-2">
                {held.map((r) => (
                  <div
                    key={r.id}
                    className="flex items-center justify-between gap-3 rounded-xl bg-raised px-3 py-2 text-sm"
                  >
                    <span className="min-w-0 truncate">
                      {r.source} — {r.description || 'No description'}
                    </span>
                    <span className="shrink-0 text-xs text-muted">
                      {formatUsd(r.estimatedUsd)} estimated
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <section className="mt-5 grid gap-6 sm:grid-cols-2">
            <div>
              <h2 className="text-sm font-medium">By source this month</h2>
              <table className="mt-3 w-full text-sm">
                <tbody>
                  {bySource.map((row) => (
                    <tr key={row.source} className="border-t border-edge/60">
                      <td className="py-1.5">{row.source}</td>
                      <td className="py-1.5 text-right text-xs text-muted">{row.count}×</td>
                      <td className="py-1.5 text-right tabular-nums">
                        {formatUsd(String(row.usd ?? '0'))}
                      </td>
                    </tr>
                  ))}
                  {bySource.length === 0 ? (
                    <tr>
                      <td className="py-1.5 text-muted">No spending yet this month</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
            <div>
              <h2 className="text-sm font-medium">By model this month</h2>
              <table className="mt-3 w-full text-sm">
                <tbody>
                  {byModel.map((row) => (
                    <tr key={row.model} className="border-t border-edge/60">
                      <td className="max-w-0 truncate py-1.5">{row.model}</td>
                      <td className="py-1.5 text-right text-xs text-muted">{row.count}×</td>
                      <td className="py-1.5 text-right tabular-nums">
                        {formatUsd(String(row.usd ?? '0'))}
                      </td>
                    </tr>
                  ))}
                  {byModel.length === 0 ? (
                    <tr>
                      <td className="py-1.5 text-muted">No model calls this month</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>

          <section className="mt-6">
            <h2 className="text-sm font-medium">Most expensive tasks this month</h2>
            <div className="mt-3 flex flex-col gap-2">
              {topTasks.map((row) => (
                <Link
                  key={row.taskId}
                  href={`/tasks/${row.taskId}`}
                  className="flex items-center justify-between gap-3 rounded-xl bg-raised px-3 py-2 text-sm motion-safe:transition-colors hover:bg-sunken/30"
                >
                  <span className="min-w-0 truncate">
                    <span className="text-xs text-muted">[{taskTypeLabel(row.type)}]</span>{' '}
                    {truncate(row.progress || row.taskId || '', 80)}
                  </span>
                  <span className="shrink-0">{formatUsd(String(row.usd ?? '0'))}</span>
                </Link>
              ))}
              {topTasks.length === 0 ? (
                <p className="text-sm text-muted">No task spending yet this month</p>
              ) : null}
            </div>
          </section>

          <section className="mt-6 overscroll-x-contain overflow-x-auto">
            <h2 className="text-sm font-medium">Recent charges</h2>
            <table className="mt-3 w-full text-sm">
              <tbody>
                {recent.map((e) => (
                  <tr key={e.id} className="border-t border-edge/60">
                    <td className="py-1.5 text-xs text-muted whitespace-nowrap">
                      {formatDateTime(e.createdAt, tz)}
                    </td>
                    <td className="px-2 py-1.5">{e.source}</td>
                    <td className="max-w-0 truncate px-2 py-1.5 text-xs text-muted">
                      {e.description}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{formatUsd(e.usd)}</td>
                  </tr>
                ))}
                {recent.length === 0 ? (
                  <tr>
                    <td className="py-1.5 text-muted">No charges yet</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </section>
        </div>
      </details>
    </PageShell>
  );
}
