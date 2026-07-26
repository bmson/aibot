import { getAgent } from '@assistant/core';
import { approvals, tasks } from '@assistant/db';
import { and, count, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  Archive,
  ArrowUpRight,
  CalendarClock,
  CircleCheck,
  CircleX,
  Clock3,
  Hand,
  ListChecks,
  Loader2,
} from 'lucide-react';
import Link from 'next/link';
import { AutoRefresh } from '@/app/auto-refresh';
import { JellyNavTabs } from '@/app/jelly-nav-tabs';
import { requireOwner } from '@/auth';
import { formatUsd, relativeTime, stripMarkdown, truncate } from '@/lib/format';
import { getDb } from '@/lib/server';
import { btn, btnSm, cardShellClass, EmptyState, PageHeader, PageShell } from '@/lib/ui';
import { SubmitButton } from '@/lib/ui-client';
import { displayTaskStatus, StatusChip, taskTypeLabel, trustLabel } from '@/lib/views';
import { archiveOldTasks, archiveTask, restoreTask } from './actions';

export const metadata = { title: 'Activity' };

export const dynamic = 'force-dynamic';

const TERMINAL_TASK_STATUSES = ['done', 'failed', 'cancelled'] as const;
const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'needs-you', label: 'Needs you' },
  { value: 'working', label: 'Working' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'completed', label: 'Completed' },
] as const;
type ActivityFilter = (typeof FILTERS)[number]['value'];

function filterStatuses(filter: ActivityFilter): string[] | undefined {
  if (filter === 'needs-you') return ['waiting_approval', 'waiting_budget', 'needs_attention'];
  if (filter === 'working') return ['pending', 'running'];
  if (filter === 'scheduled') return ['sleeping', 'waiting_event'];
  if (filter === 'completed') return [...TERMINAL_TASK_STATUSES];
  return undefined;
}

function calendarDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

function dayHeading(date: Date, now: Date): string {
  if (calendarDay(date) === calendarDay(now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (calendarDay(date) === calendarDay(yesterday)) return 'Yesterday';
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  }).format(date);
}

const taskIcon = {
  pending: Clock3,
  running: Loader2,
  waiting_approval: Hand,
  waiting_budget: Hand,
  needs_attention: Hand,
  sleeping: CalendarClock,
  waiting_event: CalendarClock,
  done: CircleCheck,
  failed: CircleX,
  cancelled: CircleX,
} as const;

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; filter?: string }>;
}) {
  await requireOwner();
  const { view, filter: rawFilter } = await searchParams;
  const archived = view === 'archived';
  const filter = FILTERS.some((item) => item.value === rawFilter)
    ? (rawFilter as ActivityFilter)
    : 'all';
  const statuses = filterStatuses(filter);
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
          statuses ? inArray(tasks.status, statuses) : undefined,
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
  // Which parked rows are genuinely waiting on the owner. Without this the list
  // badges "Needs your approval" on tasks the Approvals page has nothing for.
  const waitingIds = rows
    .filter((task) => task.status === 'waiting_approval')
    .map((task) => task.id);
  const pendingApprovalTaskIds = new Set(
    waitingIds.length === 0
      ? []
      : (
          await db
            .selectDistinct({ taskId: approvals.taskId })
            .from(approvals)
            .where(and(inArray(approvals.taskId, waitingIds), eq(approvals.status, 'pending')))
        ).map((row) => row.taskId),
  );
  const now = new Date();
  const groups = [...new Set(rows.map((task) => calendarDay(task.updatedAt)))].map((day) => ({
    day,
    label: dayHeading(
      (rows.find((task) => calendarDay(task.updatedAt) === day) as (typeof rows)[number]).updatedAt,
      now,
    ),
    items: rows.filter((task) => calendarDay(task.updatedAt) === day),
  }));

  return (
    <PageShell size="reading">
      {archived ? null : <AutoRefresh />}
      <PageHeader
        title={archived ? 'Archived activity' : 'Activity'}
        intro={
          archived
            ? 'Hidden work stays available with its decisions and evidence intact.'
            : 'A chronological record of what AI Bot did, what it is doing, and where it needs you.'
        }
        actions={
          archived ? (
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
                <SubmitButton pendingLabel="Archiving…">
                  <Archive className="size-3.5" aria-hidden="true" />
                  Archive old
                </SubmitButton>
              </form>
            </>
          )
        }
      />

      {!archived ? (
        <JellyNavTabs
          className="mt-7"
          label="Filter activity"
          value={filter}
          items={FILTERS.map((item) => ({
            ...item,
            href: item.value === 'all' ? '/tasks' : `/tasks?filter=${item.value}`,
          }))}
        />
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          icon={<ListChecks className="size-5" />}
          action={
            archived || filter !== 'all' ? (
              <Link href={archived ? '/tasks' : '/tasks'} className={btn.outline}>
                {archived ? 'Current activity' : 'Clear filter'}
              </Link>
            ) : (
              <Link href="/chat" className={btn.outline}>
                Start in chat
              </Link>
            )
          }
        >
          {archived
            ? 'No archived activity.'
            : filter === 'all'
              ? 'Nothing yet. Give AI Bot something in chat and its work will appear here.'
              : `No ${FILTERS.find((item) => item.value === filter)?.label.toLowerCase()} activity.`}
        </EmptyState>
      ) : (
        <div className="mt-10 flex flex-col gap-10">
          {groups.map((group) => (
            <section key={group.day}>
              <div className="mb-4 flex items-center gap-3">
                <h2 className="font-display text-sm font-semibold tracking-[-0.01em] text-strong">
                  {group.label}
                </h2>
                <span className="text-2xs text-muted tabular-nums">
                  {group.items.length} {group.items.length === 1 ? 'event' : 'events'}
                </span>
                <span className="h-px flex-1 bg-gradient-to-r from-edge/80 to-transparent" />
              </div>
              <div className="activity-timeline">
                {group.items.map((task, index) => {
                  const Icon = taskIcon[task.status as keyof typeof taskIcon] ?? Clock3;
                  const terminal = TERMINAL_TASK_STATUSES.includes(
                    task.status as (typeof TERMINAL_TASK_STATUSES)[number],
                  );
                  const shownStatus = displayTaskStatus(
                    task.status,
                    pendingApprovalTaskIds.has(task.id),
                  );
                  return (
                    // Each row leads somewhere, so it lights up under the
                    // pointer — scanning a long day of activity should feel
                    // like a list you can move through, not a static table.
                    <article
                      key={task.id}
                      className={`${cardShellClass} activity-event group/activity relative grid grid-cols-[2.25rem_minmax(0,1fr)] gap-3 px-4 py-4 sm:grid-cols-[2.25rem_minmax(0,1fr)_auto] sm:items-center sm:px-5 ${
                        index > 0 ? 'mt-3' : ''
                      }`}
                    >
                      <span
                        className={`activity-node relative z-10 inline-flex size-9 items-center justify-center rounded-xl border border-edge/70 bg-surface text-muted shadow-[0_1px_2px_rgb(23_25_35/0.05)] ${
                          task.status === 'running'
                            ? 'activity-node-running border-accent/25 bg-accent/10 text-accent'
                            : ''
                        }`}
                      >
                        <Icon
                          className={`size-4 ${task.status === 'running' ? 'motion-safe:animate-spin' : ''}`}
                          aria-hidden="true"
                        />
                      </span>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link
                            href={`/tasks/${task.id}`}
                            className="text-[15px] font-semibold tracking-[-0.01em] hover:underline"
                          >
                            {task.title || taskTypeLabel(task.type)}
                          </Link>
                          <StatusChip status={shownStatus} />
                        </div>
                        <p className="mt-1.5 line-clamp-2 max-w-2xl text-[13px] leading-5 text-muted">
                          {truncate(stripMarkdown(task.progress), 180) || 'No update recorded yet.'}
                        </p>
                        <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted">
                          <span>Started by {trustLabel(task.trust)}</span>
                          <span aria-hidden="true" className="size-0.5 rounded-full bg-muted/50" />
                          <span className="tabular-nums">
                            {formatUsd(task.spentUsd)} of {formatUsd(task.budgetUsdLimit)}
                          </span>
                          <span aria-hidden="true" className="size-0.5 rounded-full bg-muted/50" />
                          <span>Updated {relativeTime(task.updatedAt, now)}</span>
                        </div>
                      </div>
                      <div className="col-start-2 flex items-center gap-2 sm:col-start-auto sm:justify-end">
                        <Link
                          href={`/tasks/${task.id}`}
                          className={`${btnSm.outline} group-hover/activity:border-accent/25 group-hover/activity:text-accent`}
                        >
                          View
                          <ArrowUpRight className="size-3.5" aria-hidden="true" />
                        </Link>
                        {archived ? (
                          <form action={restoreTask.bind(null, task.id)}>
                            <SubmitButton size="sm" pendingLabel="Restoring…">
                              Restore
                            </SubmitButton>
                          </form>
                        ) : terminal ? (
                          <form action={archiveTask.bind(null, task.id)}>
                            <SubmitButton size="sm" pendingLabel="Archiving…">
                              Archive
                            </SubmitButton>
                          </form>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </PageShell>
  );
}
