import { getAgent } from '@assistant/core';
import { tasks } from '@assistant/db';
import { and, count, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  Archive,
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
import { requireOwner } from '@/auth';
import { formatUsd, relativeTime, stripMarkdown, truncate } from '@/lib/format';
import { getDb } from '@/lib/server';
import {
  btn,
  btnSm,
  cardShellClass,
  EmptyState,
  PageHeader,
  PageShell,
  segmentedControlClass,
  segmentedItemClass,
} from '@/lib/ui';
import { SubmitButton } from '@/lib/ui-client';
import { StatusChip, taskTypeLabel, trustLabel } from '@/lib/views';
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
    <PageShell>
      {archived ? null : <AutoRefresh />}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeader
          title={archived ? 'Archived activity' : 'Activity'}
          intro={
            archived
              ? 'Hidden work stays available with its decisions and evidence intact.'
              : 'A chronological record of what AI Bot did, what it is doing, and where it needs you.'
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
                <SubmitButton pendingLabel="Archiving…">
                  <Archive className="size-3.5" aria-hidden="true" />
                  Archive old
                </SubmitButton>
              </form>
            </>
          )}
        </div>
      </div>

      {!archived ? (
        <nav aria-label="Filter activity" className={`${segmentedControlClass} mt-7`}>
          {FILTERS.map((item) => {
            const active = filter === item.value;
            return (
              <Link
                key={item.value}
                href={item.value === 'all' ? '/tasks' : `/tasks?filter=${item.value}`}
                aria-current={active ? 'page' : undefined}
                className={`${segmentedItemClass} ${
                  active ? 'bg-raised text-strong shadow-sm' : ''
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
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
        <div className="mt-8 flex flex-col gap-8">
          {groups.map((group) => (
            <section key={group.day}>
              <h2 className="mb-3 text-xs font-semibold tracking-[0.1em] text-muted uppercase">
                {group.label}
              </h2>
              <div className={cardShellClass}>
                {group.items.map((task, index) => {
                  const Icon = taskIcon[task.status as keyof typeof taskIcon] ?? Clock3;
                  const terminal = TERMINAL_TASK_STATUSES.includes(
                    task.status as (typeof TERMINAL_TASK_STATUSES)[number],
                  );
                  return (
                    <article
                      key={task.id}
                      className={`grid grid-cols-[2rem_minmax(0,1fr)] gap-3 px-4 py-4 sm:grid-cols-[2rem_minmax(0,1fr)_auto] sm:items-center sm:px-5 ${
                        index > 0 ? 'border-t border-edge' : ''
                      }`}
                    >
                      <span
                        className={`inline-flex size-8 items-center justify-center rounded-xl bg-sunken text-muted ${
                          task.status === 'running' ? 'text-accent' : ''
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
                          <StatusChip status={task.status} />
                        </div>
                        <p className="mt-1 line-clamp-2 text-[13px] leading-5 text-muted">
                          {truncate(stripMarkdown(task.progress), 180) || 'No update recorded yet.'}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-1.5 text-2xs text-muted">
                          <span className="rounded-md bg-sunken/65 px-2 py-1">
                            Started by {trustLabel(task.trust)}
                          </span>
                          <span className="rounded-md bg-sunken/65 px-2 py-1">
                            Spent {formatUsd(task.spentUsd)} / {formatUsd(task.budgetUsdLimit)}
                          </span>
                          <span className="rounded-md bg-sunken/65 px-2 py-1">
                            Updated {relativeTime(task.updatedAt, now)}
                          </span>
                        </div>
                      </div>
                      <div className="col-start-2 flex items-center gap-2 sm:col-start-auto sm:justify-end">
                        <Link href={`/tasks/${task.id}`} className={btnSm.outline}>
                          Open
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
