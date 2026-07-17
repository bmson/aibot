import { tasks } from '@assistant/db';
import { desc, sql } from 'drizzle-orm';
import Link from 'next/link';
import { requireOwner } from '@/auth';
import { formatUsd, relativeTime, truncate } from '@/lib/format';
import { getDb } from '@/lib/server';
import { EmptyState, PageHeader } from '@/lib/ui';
import { StatusChip } from '@/lib/views';

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
        title="Tasks"
        intro="Everything the assistant is working on — running, queued, and completed tasks."
      />

      {rows.length === 0 ? (
        <EmptyState>No tasks yet — work the assistant picks up will appear here.</EmptyState>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-200 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              <tr>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Trust</th>
                <th className="px-3 py-2 font-medium">Progress</th>
                <th className="px-3 py-2 font-medium">Spent</th>
                <th className="px-3 py-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {rows.map((task) => (
                <tr key={task.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-900/50">
                  <td className="px-3 py-2">
                    <Link href={`/tasks/${task.id}`} className="font-medium hover:underline">
                      {task.type}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <StatusChip status={task.status} />
                  </td>
                  <td className="px-3 py-2 text-zinc-600 dark:text-zinc-400">{task.trust}</td>
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
      )}
    </div>
  );
}
