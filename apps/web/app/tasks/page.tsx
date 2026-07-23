import { getAgent } from '@assistant/core';
import { tasks } from '@assistant/db';
import { and, count, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import Link from 'next/link';
import { AutoRefresh } from '@/app/auto-refresh';
import { requireOwner } from '@/auth';
import { formatUsd, relativeTime, truncate } from '@/lib/format';
import { getDb } from '@/lib/server';
import { btn, EmptyState, PageHeader } from '@/lib/ui';
import { StatusChip, taskTypeLabel, trustLabel } from '@/lib/views';
import { archiveOldTasks, archiveTask, restoreTask } from './actions';

export const dynamic = 'force-dynamic';

const TERMINAL_TASK_STATUSES = new Set(['done', 'failed', 'cancelled']);

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  await requireOwner();
  const { view } = await searchParams;
  const archived = view === 'archived';
  const db = getDb();
  const agent = await getAgent(db);
  const [rows, archivedCountRows] = await Promise.all([
    db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.agentId, agent.id),
          sql`${tasks.trigger}->'payload'->>'canary' IS DISTINCT FROM 'true'`,
          archived ? isNotNull(tasks.archivedAt) : isNull(tasks.archivedAt),
        ),
      )
      .orderBy(desc(tasks.updatedAt))
      .limit(50),
    db
      .select({ value: count() })
      .from(tasks)
      .where(and(eq(tasks.agentId, agent.id), isNotNull(tasks.archivedAt))),
  ]);
  const archivedCount = archivedCountRows[0]?.value ?? 0;
  const now = new Date();

  return (
    <div className="mx-auto max-w-4xl">
      {archived ? null : <AutoRefresh />}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          title={archived ? 'Archived activity' : 'Activity'}
          intro={
            archived
              ? 'Hidden activity stays available with its task, approvals, and tool evidence intact.'
              : 'A factual record of work. Archive finished items when you no longer need them in the daily view.'
          }
        />
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {archived ? (
            <Link href="/tasks" className={btn.outline}>
              Current activity
            </Link>
          ) : (
            <>
              {archivedCount > 0 ? (
                <Link href="/tasks?view=archived" className={btn.outline}>
                  Archived ({archivedCount})
                </Link>
              ) : null}
              <form action={archiveOldTasks}>
                <button type="submit" className={btn.outline}>
                  Archive old activity (30+ days)
                </button>
              </form>
            </>
          )}
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState>
          {archived
            ? 'No archived activity.'
            : 'No activity yet — work the assistant picks up appears here.'}
        </EmptyState>
      ) : (
        <>
          <div className="mt-6 flex flex-col gap-3 sm:hidden">
            {rows.map((task) => (
              <article
                key={task.id}
                className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
              >
                <Link href={`/tasks/${task.id}`} className="block">
                  <div className="flex items-start justify-between gap-3">
                    <span className="font-medium">{task.title || taskTypeLabel(task.type)}</span>
                    <StatusChip status={task.status} />
                  </div>
                  <p className="mt-2 line-clamp-2 text-xs text-zinc-600 dark:text-zinc-400">
                    {truncate(task.progress, 140) || 'No update recorded yet.'}
                  </p>
                  <div className="mt-3 flex items-center justify-between gap-3 text-xs text-zinc-500 dark:text-zinc-500">
                    <span>{formatUsd(task.spentUsd)} spent</span>
                    <span>{relativeTime(task.updatedAt, now)}</span>
                  </div>
                </Link>
                <div className="mt-3 flex justify-end">
                  {archived ? (
                    <form action={restoreTask.bind(null, task.id)}>
                      <button type="submit" className={btn.outline}>
                        Restore
                      </button>
                    </form>
                  ) : TERMINAL_TASK_STATUSES.has(task.status) ? (
                    <form action={archiveTask.bind(null, task.id)}>
                      <button type="submit" className={btn.outline}>
                        Archive
                      </button>
                    </form>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
          <div className="mt-6 hidden overflow-x-auto rounded-lg border border-zinc-200 sm:block dark:border-zinc-800">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-zinc-200 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                <tr>
                  <th className="px-3 py-2 font-medium">Work</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Started by</th>
                  <th className="px-3 py-2 font-medium">Latest update</th>
                  <th className="px-3 py-2 font-medium">Spent</th>
                  <th className="px-3 py-2 font-medium">Updated</th>
                  <th className="px-3 py-2">
                    <span className="sr-only">Archive</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                {rows.map((task) => (
                  <tr key={task.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-900/50">
                    <td className="px-3 py-2">
                      <Link href={`/tasks/${task.id}`} className="font-medium hover:underline">
                        {task.title || taskTypeLabel(task.type)}
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      <StatusChip status={task.status} />
                    </td>
                    <td className="px-3 py-2 text-zinc-600 dark:text-zinc-400">
                      {trustLabel(task.trust)}
                    </td>
                    <td className="max-w-64 px-3 py-2 text-zinc-600 dark:text-zinc-400">
                      <span className="block truncate">{truncate(task.progress, 120) || '—'}</span>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-zinc-600 dark:text-zinc-400">
                      {formatUsd(task.spentUsd)} / {formatUsd(task.budgetUsdLimit)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-zinc-500 dark:text-zinc-500">
                      {relativeTime(task.updatedAt, now)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {archived ? (
                        <form action={restoreTask.bind(null, task.id)}>
                          <button type="submit" className={btn.outline}>
                            Restore
                          </button>
                        </form>
                      ) : TERMINAL_TASK_STATUSES.has(task.status) ? (
                        <form action={archiveTask.bind(null, task.id)}>
                          <button type="submit" className={btn.outline}>
                            Archive
                          </button>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
