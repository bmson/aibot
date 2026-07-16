import { approvals, goals, tasks } from '@assistant/db';
import { and, asc, desc, eq, inArray, notInArray } from 'drizzle-orm';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ApprovalCard } from '@/app/approvals/approval-card';
import { cancelTask, retryTask } from '@/app/tasks/actions';
import { requireOwner } from '@/auth';
import { formatDateTime, relativeTime, truncate } from '@/lib/format';
import { getDb } from '@/lib/server';
import { StatusChip, toPendingApprovalView } from '@/lib/views';

export const dynamic = 'force-dynamic';

const actionButton =
  'rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800';

function Section({
  icon,
  title,
  subtitle,
  empty,
  count,
  children,
}: {
  icon: string;
  title: string;
  subtitle: string;
  empty: string;
  count: number;
  children?: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
      <div className="flex items-baseline gap-2">
        <span aria-hidden="true">{icon}</span>
        <h2 className="text-sm font-medium">{title}</h2>
        <span className="text-xs text-zinc-500 dark:text-zinc-500">{subtitle}</span>
      </div>
      {count === 0 ? (
        <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">{empty}</p>
      ) : (
        <div className="mt-3 flex flex-col gap-3">{children}</div>
      )}
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
    db.select().from(goals).orderBy(asc(goals.priority), desc(goals.updatedAt)),
  ]);

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-xl font-semibold">Dashboard</h1>
      <div className="mt-6 flex flex-col gap-4">
        <Section
          icon="⚠️"
          title="Needs approval"
          subtitle="Actions awaiting your sign-off"
          empty="Nothing to approve — actions that need your sign-off will appear here."
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
          icon="🚨"
          title="Needs attention"
          subtitle="Dead-lettered tasks that need a human"
          empty="Nothing stuck — tasks that exhausted their retries will appear here."
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
                  <button type="submit" className={actionButton}>
                    Retry
                  </button>
                </form>
                <form action={cancelTask.bind(null, task.id)}>
                  <button type="submit" className={actionButton}>
                    Cancel
                  </button>
                </form>
              </div>
            </div>
          ))}
        </Section>

        <Section
          icon="⏳"
          title="Waiting"
          subtitle="Blocked or pending on something else"
          empty="Nothing waiting — no tasks are blocked or pending."
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

        <Section
          icon="✓"
          title="Done"
          subtitle="Recently completed"
          empty="Nothing yet — the assistant hasn’t completed any work."
          count={recentDone.length}
        >
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

        <Section
          icon="👁"
          title="Monitoring"
          subtitle="Missions and schedules"
          empty="No missions yet — active missions and schedules will appear here."
          count={missions.length}
        >
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

        <Section
          icon="🎯"
          title="Goals"
          subtitle="Long-running objectives"
          empty="No goals yet — long-running objectives will appear here."
          count={goalRows.length}
        >
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
