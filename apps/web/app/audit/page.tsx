import type { ActivityFilter } from '@assistant/application/tasks';
import Link from 'next/link';
import { requireOwner } from '@/auth';
import { formatDateTime, formatUsd } from '@/lib/format';
import { listTaskActivity } from '@/lib/task-activity';
import { btn, EmptyState, inputClass, PageHeader, PageShell } from '@/lib/ui';
import { StatusChip } from '@/lib/views';

export const metadata = { title: 'Audit trail' };
export const dynamic = 'force-dynamic';
const filters = ['all', 'needs-you', 'working', 'scheduled', 'completed'] as const;

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; view?: string; q?: string }>;
}) {
  await requireOwner();
  const query = await searchParams;
  const filter: ActivityFilter = filters.includes(query.filter as ActivityFilter)
    ? (query.filter as ActivityFilter)
    : 'all';
  const archived = query.view === 'archived';
  const { items } = await listTaskActivity({ archived, filter, limit: 100 });
  const search = (query.q ?? '').trim().slice(0, 200).toLowerCase();
  const rows = items.filter(
    (task) =>
      !search || `${task.id} ${task.title ?? ''} ${task.progress}`.toLowerCase().includes(search),
  );
  return (
    <PageShell size="reading" className="grid gap-6">
      <PageHeader
        title="Audit trail"
        intro="Inspect recent work, tool results, model calls, and approval decisions to track down issues."
      />
      <form className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-sm">
          Search recent records
          <input
            name="q"
            defaultValue={query.q}
            maxLength={200}
            placeholder="Task name or ID"
            className={inputClass}
          />
        </label>
        <label className="grid gap-1 text-sm">
          Status
          <select name="filter" defaultValue={filter} className={inputClass}>
            {filters.map((value) => (
              <option key={value} value={value}>
                {value.replaceAll('-', ' ')}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          Records
          <select
            name="view"
            defaultValue={archived ? 'archived' : 'current'}
            className={inputClass}
          >
            <option value="current">Current</option>
            <option value="archived">Archived</option>
          </select>
        </label>
        <button className={btn.outline} type="submit">
          Filter
        </button>
      </form>
      <p className="text-xs text-muted">
        Search covers the latest 100 records in the selected view. Open a record to inspect its
        timeline. Refresh this page for the latest status.
      </p>
      {rows.length === 0 ? (
        <EmptyState>
          No matching records. Work started in the mobile app will appear here.
        </EmptyState>
      ) : (
        <div className="divide-y divide-edge border-y border-edge">
          {rows.map((task) => (
            <article key={task.id} className="grid gap-2 py-5">
              <div className="flex flex-wrap items-center gap-3">
                <Link href={`/audit/${task.id}`} className="font-semibold hover:underline">
                  {task.title || task.type}
                </Link>
                <StatusChip status={task.status} />
              </div>
              <p className="text-sm text-muted break-words">
                {task.progress || 'No progress recorded.'}
              </p>
              <p className="text-xs text-muted">
                {formatDateTime(task.updatedAt)} · {formatUsd(task.spentUsd)}
              </p>
              <code className="text-xs text-muted break-all">{task.id}</code>
            </article>
          ))}
        </div>
      )}
    </PageShell>
  );
}
