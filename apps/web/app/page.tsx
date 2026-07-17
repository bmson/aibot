import { approvals, goals, tasks } from '@assistant/db';
import { and, asc, desc, eq, inArray, notInArray } from 'drizzle-orm';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ApprovalCard } from '@/app/approvals/approval-card';
import { cancelTask, retryTask } from '@/app/tasks/actions';
import { requireOwner } from '@/auth';
import { formatDateTime, relativeTime, truncate } from '@/lib/format';
import { getDb } from '@/lib/server';
import { btn, CountBadge, PageHeader, SectionHeading } from '@/lib/ui';
import { StatusChip, toPendingApprovalView } from '@/lib/views';

export const dynamic = 'force-dynamic';

/** A dashboard section renders only when it has content — empty ones stay out of the way. */
function Section({
  title,
  subtitle,
  count,
  children,
}: {
  title: string;
  subtitle: string;
  count: number;
  children?: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <section className="rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
      <div className="flex items-baseline gap-2">
        <SectionHeading title={title} hint={subtitle} />
        <CountBadge>{count}</CountBadge>
      </div>
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </section>
  );
}

const waitingLine: Record<string, string> = {
  waiting_approval: 'waiting for your approval',
  waiting_event: 'waiting for an external event',
};

export default async function DashboardPage() {
  await requireOwner();
  const db = getDb();
  const now = new Date();

  const [pendingApprovals, attention, waiting, recentDone, missions, goalRows] = await Promise.all([
    db
      .select({ approval: approvals, taskType: tasks.type, taskTrust: tasks.trust })
      .from(approvals)
      .innerJoin(tasks, eq(approvals.taskId, tasks.id))
      .where(eq(approvals.status, 'pending'))
      .orderBy(asc(approvals.requestedAt)),
    db
      .select()
      .from(tasks)
      .where(eq(tasks.status, 'needs_attention'))
      .orderBy(desc(tasks.updatedAt)),
    db
      .select()
      .from(tasks)
      .where(inArray(tasks.status, ['waiting_approval', 'waiting_event', 'sleeping']))
      .orderBy(desc(tasks.updatedAt)),
    db
      .select()
      .from(tasks)
      .where(inArray(tasks.status, ['done', 'failed']))
      .orderBy(desc(tasks.updatedAt))
      .limit(10),
    db
      .select()
      .from(tasks)
      .where(
        and(eq(tasks.type, 'mission'), notInArray(tasks.status, ['done', 'failed', 'cancelled'])),
      )
      .orderBy(desc(tasks.updatedAt)),
    db
      .select({ id: goals.id, title: goals.title, status: goals.status, priority: goals.priority })
      .from(goals)
      .orderBy(asc(goals.priority), desc(goals.updatedAt)),
  ]);

  const totalItems =
    pendingApprovals.length +
    attention.length +
    waiting.length +
    recentDone.length +
    missions.length +
    goalRows.length;

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Dashboard" />
      {totalItems === 0 ? (
        <p className="mt-6 rounded-lg border border-zinc-200 p-5 text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
          All quiet — nothing needs you. Approvals, stuck tasks, and running work will show up here.
        </p>
      ) : null}
      <div className="mt-6 flex flex-col gap-4">
        <Section
          title="Needs approval"
          subtitle="Actions awaiting your sign-off"
          count={pendingApprovals.length}
        >
          {pendingApprovals.map(({ approval, taskType, taskTrust }) => (
            <ApprovalCard
              key={approval.id}
              approval={toPendingApprovalView(approval, { type: taskType, trust: taskTrust }, now)}
            />
          ))}
        </Section>

        <Section
          title="Needs attention"
          subtitle="Dead-lettered tasks that need a human"
          count={attention.length}
        >
          {attention.map((task) => (
            <div
              key={task.id}
              className="flex items-center justify-between gap-3 rounded-md border border-orange-200 bg-orange-50/50 px-3 py-2 dark:border-orange-900/60 dark:bg-orange-950/20"
            >
              <div className="min-w-0">
                <Link href={`/tasks/${task.id}`} className="text-sm font-medium hover:underline">
                  {task.type}
                </Link>
                <p className="truncate text-xs text-zinc-600 dark:text-zinc-400">
                  {task.progress || 'no progress recorded'}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <form action={retryTask.bind(null, task.id)}>
                  <button type="submit" className={btn.outline}>
                    Retry
                  </button>
                </form>
                <form action={cancelTask.bind(null, task.id)}>
                  <button type="submit" className={btn.outline}>
                    Cancel
                  </button>
                </form>
              </div>
            </div>
          ))}
        </Section>

        <Section
          title="Waiting"
          subtitle="Blocked or pending on something else"
          count={waiting.length}
        >
          {waiting.map((task) => {
            const line =
              task.status === 'sleeping'
                ? task.runAfter
                  ? `sleeping until ${formatDateTime(task.runAfter)} (${relativeTime(task.runAfter, now)})`
                  : 'sleeping'
                : (waitingLine[task.status] ?? task.status);
            return (
              <div key={task.id} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <Link href={`/tasks/${task.id}`} className="text-sm font-medium hover:underline">
                    {task.type}
                  </Link>
                  <p className="text-xs text-zinc-600 dark:text-zinc-400">{line}</p>
                  {task.nextAction ? (
                    <p className="truncate text-xs text-zinc-500 dark:text-zinc-500">
                      next: {task.nextAction}
                    </p>
                  ) : null}
                  {task.progress ? (
                    <p className="truncate text-xs text-zinc-500 dark:text-zinc-500">
                      {task.progress}
                    </p>
                  ) : null}
                </div>
                <StatusChip status={task.status} />
              </div>
            );
          })}
        </Section>

        <Section title="Done" subtitle="Recently completed" count={recentDone.length}>
          {recentDone.map((task) => (
            <div key={task.id} className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-baseline gap-2">
                <span
                  aria-hidden="true"
                  className={
                    task.status === 'done'
                      ? 'text-green-600 dark:text-green-400'
                      : 'text-red-600 dark:text-red-400'
                  }
                >
                  {task.status === 'done' ? '✓' : '✗'}
                </span>
                <Link href={`/tasks/${task.id}`} className="text-sm font-medium hover:underline">
                  {task.type}
                </Link>
                <span className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                  {task.progress}
                </span>
              </div>
              <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-500">
                {relativeTime(task.updatedAt, now)}
              </span>
            </div>
          ))}
        </Section>

        <Section title="Monitoring" subtitle="Missions in flight" count={missions.length}>
          {missions.map((task) => {
            const percent =
              task.progressPercent ??
              (task.deadline
                ? Math.min(
                    100,
                    Math.max(
                      0,
                      Math.round(
                        ((now.getTime() - task.createdAt.getTime()) /
                          (task.deadline.getTime() - task.createdAt.getTime())) *
                          100,
                      ),
                    ),
                  )
                : null);
            return (
              <div key={task.id}>
                <div className="flex items-center justify-between gap-3">
                  <Link href={`/tasks/${task.id}`} className="text-sm font-medium hover:underline">
                    {truncate(task.progress || task.nextAction || 'mission', 80)}
                  </Link>
                  <StatusChip status={task.status} />
                </div>
                {percent !== null ? (
                  <div className="mt-2 flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                      <div
                        className="h-full rounded-full bg-blue-500 dark:bg-blue-400"
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                    <span className="text-xs text-zinc-500 dark:text-zinc-500">{percent}%</span>
                  </div>
                ) : null}
                {task.deadline ? (
                  <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
                    deadline {formatDateTime(task.deadline)} ({relativeTime(task.deadline, now)})
                  </p>
                ) : null}
              </div>
            );
          })}
        </Section>

        <Section title="Goals" subtitle="Long-running objectives" count={goalRows.length}>
          {goalRows.map((goal) => (
            <div key={goal.id} className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate text-sm font-medium">{goal.title}</span>
              <span className="flex shrink-0 items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                <StatusChip status={goal.status} />P{goal.priority}
              </span>
            </div>
          ))}
        </Section>
      </div>
    </div>
  );
}
