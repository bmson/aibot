import { tasks } from '@assistant/db';
import { desc, sql } from 'drizzle-orm';
import Link from 'next/link';
import { requireOwner } from '@/auth';
import { formatUsd, relativeTime, truncate } from '@/lib/format';
import { getDb } from '@/lib/server';
import { EmptyState, PageHeader } from '@/lib/ui';
import { StatusChip, taskTypeLabel, trustLabel } from '@/lib/views';

export const dynamic = 'force-dynamic';

export default async function TasksPage() {
  await requireOwner();
  const db = getDb();
  const now = new Date();

  const rows = await db
    .select()
    .from(tasks)
    .where(sql`${tasks.trigger}->'payload'->>'canary' IS DISTINCT FROM 'true'`)
    .orderBy(desc(tasks.updatedAt))
    .limit(50);

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Activity"
        intro="A factual record of work: what is waiting, what ran, and what finished. Open an item to see the proof behind an update."
      />

      {rows.length === 0 ? (
        <EmptyState>No activity yet — work the assistant picks up will appear here.</EmptyState>
      ) : (
        <>
          <div className="mt-6 flex flex-col gap-3 sm:hidden">
            {rows.map((task) => (
              <Link
                key={task.id}
                href={`/tasks/${task.id}`}
                className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="font-medium">{taskTypeLabel(task.type)}</span>
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
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                {rows.map((task) => (
                  <tr key={task.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-900/50">
                    <td className="px-3 py-2">
                      <Link href={`/tasks/${task.id}`} className="font-medium hover:underline">
                        {taskTypeLabel(task.type)}
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
