import { evaluateCanaryHealth } from '@assistant/core';
import { approvals, canaryRuns, goals, tasks, toolCalls } from '@assistant/db';
import { and, asc, desc, eq, inArray, isNull, notInArray } from 'drizzle-orm';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ApprovalCard } from '@/app/approvals/approval-card';
import { cancelTask, retryTask } from '@/app/tasks/actions';
import { requireOwner } from '@/auth';
import { formatDateTime, relativeTime, truncate } from '@/lib/format';
import { getAgentTimezone, getDb } from '@/lib/server';
import { btn, CountBadge, PageHeader, SectionHeading } from '@/lib/ui';
import { StatusChip, taskTypeLabel, toPendingApprovalView } from '@/lib/views';

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
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-baseline gap-2">
        <SectionHeading title={title} hint={subtitle} />
        <CountBadge>{count}</CountBadge>
      </div>
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </section>
  );
}

const waitingLine: Record<string, string> = {
  waiting_approval: 'Needs a decision from you. Open Approvals to continue it.',
  waiting_event: 'Waiting for a reply or another external event.',
  waiting_budget: 'Paused until the relevant spending limit resets.',
};

const canaryLabels: Record<string, string> = {
  gmail: 'Email',
  sms: 'Text messaging',
  browser: 'Browser',
  approval: 'Approvals',
  chat: 'Chat',
};

export default async function DashboardPage() {
  await requireOwner();
  const db = getDb();
  const now = new Date();
  const tz = await getAgentTimezone();

  const dashboardData = await Promise.all([
    db
      .select({
        approval: approvals,
        taskType: tasks.type,
        taskTrust: tasks.trust,
        toolName: toolCalls.toolName,
        decision: toolCalls.decision,
      })
      .from(approvals)
      .innerJoin(tasks, eq(approvals.taskId, tasks.id))
      .innerJoin(toolCalls, eq(approvals.toolCallId, toolCalls.id))
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
      .where(
        inArray(tasks.status, ['waiting_approval', 'waiting_event', 'waiting_budget', 'sleeping']),
      )
      .orderBy(desc(tasks.updatedAt)),
    db
      .select()
      .from(tasks)
      .where(and(inArray(tasks.status, ['done', 'failed']), isNull(tasks.archivedAt)))
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
      .select({
        id: goals.id,
        title: goals.title,
        status: goals.status,
        priority: goals.priority,
      })
      .from(goals)
      .where(isNull(goals.archivedAt))
      .orderBy(asc(goals.priority), desc(goals.updatedAt)),
    db.select().from(canaryRuns).orderBy(desc(canaryRuns.startedAt)).limit(1),
  ]).catch((error: unknown) => {
    console.error('[dashboard] failed to load page data', error);
    return null;
  });
  if (!dashboardData) {
    return (
      <div className="mx-auto max-w-4xl">
        <PageHeader title="Home" />
        <p className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-200">
          The dashboard is having trouble loading live data right now. The app shell is still up,
          and we are treating this as a data-layer failure rather than a full outage.
        </p>
      </div>
    );
  }
  const [pendingApprovals, attention, waiting, recentDone, missions, goalRows, [latestCanary]] =
    dashboardData;
  const canaryHealth = evaluateCanaryHealth(latestCanary, { now });
  const failedCanaryChecks = Object.entries(
    (latestCanary?.checks ?? {}) as Record<string, { ok?: boolean }>,
  )
    .filter(([, check]) => check.ok === false)
    .map(([name]) => canaryLabels[name] ?? name.replaceAll('_', ' '));
  const showServiceWarning = canaryHealth.state === 'failed' || canaryHealth.state === 'stale';

  const needsYou = pendingApprovals.length + attention.length;

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Your assistant"
        intro="Start in chat. Come back here when the assistant needs a decision or has a verified update to show you."
      />
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-indigo-100 bg-indigo-50/70 p-4 dark:border-indigo-900/60 dark:bg-indigo-950/30">
        <div>
          <p className="text-sm font-medium text-slate-900 dark:text-zinc-100">
            {needsYou === 0
              ? 'You’re all caught up.'
              : `${needsYou} item${needsYou === 1 ? '' : 's'} need your attention.`}
          </p>
          <p className="mt-1 text-xs text-slate-600 dark:text-zinc-400">
            {needsYou === 0
              ? 'The assistant will ask when it needs approval or a decision.'
              : 'Review approvals or unblock a task to keep work moving.'}
          </p>
        </div>
        <Link
          href="/chat"
          data-mobile-touch-target="true"
          className="mobile-touch-target inline-flex items-center rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-indigo-700"
        >
          Ask assistant
        </Link>
      </div>
      {showServiceWarning ? (
        <section className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900/60 dark:bg-amber-950/20">
          <h2 className="text-sm font-medium text-amber-950 dark:text-amber-200">
            An assistant service check needs attention
          </h2>
          <p className="mt-1 text-xs leading-5 text-amber-900 dark:text-amber-300">
            {canaryHealth.detail}
            {latestCanary?.finishedAt
              ? ` Last checked ${relativeTime(latestCanary.finishedAt, now)}.`
              : ''}
            {failedCanaryChecks.length > 0
              ? ` Problem area: ${failedCanaryChecks.join(', ')}.`
              : ''}
            {' The assistant retries these checks automatically; open Activity if work is failing.'}
          </p>
        </section>
      ) : null}
      <div className="mt-6 flex flex-col gap-4">
        <Section
          title="Needs approval"
          subtitle="Actions awaiting your sign-off"
          count={pendingApprovals.length}
        >
          {pendingApprovals.map(({ approval, taskType, taskTrust, toolName, decision }) => (
            <ApprovalCard
              key={approval.id}
              approval={toPendingApprovalView(
                approval,
                { type: taskType, trust: taskTrust },
                { toolName, decision },
                now,
                tz,
              )}
            />
          ))}
        </Section>

        <Section
          title="Needs your help"
          subtitle="A decision or retry will unblock this work"
          count={attention.length}
        >
          {attention.map((task) => (
            <div
              key={task.id}
              className="flex items-center justify-between gap-3 rounded-md border border-orange-200 bg-orange-50/50 px-3 py-2 dark:border-orange-900/60 dark:bg-orange-950/20"
            >
              <div className="min-w-0">
                <Link
                  href={`/tasks/${task.id}`}
                  data-mobile-touch-target="true"
                  className="mobile-touch-target inline-flex items-center text-sm font-medium hover:underline"
                >
                  {task.title || taskTypeLabel(task.type)}
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
          title="Up next"
          subtitle="Work that will continue on its own — no action is needed from you"
          count={waiting.length}
        >
          {waiting.map((task) => {
            const line =
              task.status === 'sleeping'
                ? task.runAfter
                  ? `Next check ${relativeTime(task.runAfter, now)} (${formatDateTime(task.runAfter, tz)})`
                  : 'Its next check is being scheduled.'
                : (waitingLine[task.status] ?? task.status);
            return (
              <div key={task.id} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <Link
                    href={`/tasks/${task.id}`}
                    data-mobile-touch-target="true"
                    className="mobile-touch-target inline-flex items-center text-sm font-medium hover:underline"
                  >
                    {task.title || taskTypeLabel(task.type)}
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
          title="Recent results"
          subtitle="The latest finished work"
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
                <Link
                  href={`/tasks/${task.id}`}
                  data-mobile-touch-target="true"
                  className="mobile-touch-target inline-flex items-center text-sm font-medium hover:underline"
                >
                  {task.title || taskTypeLabel(task.type)}
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
          title="Automatic work"
          subtitle="Longer-running work the assistant checks on a schedule"
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
                  <Link
                    href={`/tasks/${task.id}`}
                    className="min-w-0 truncate text-sm font-medium hover:underline"
                  >
                    {truncate(task.progress || task.nextAction || 'Ongoing task', 80)}
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
                    target {formatDateTime(task.deadline, tz)} ({relativeTime(task.deadline, now)})
                  </p>
                ) : null}
              </div>
            );
          })}
        </Section>

        <Section
          title="Goals"
          subtitle="Outcomes you want the assistant to keep moving forward"
          count={goalRows.length}
        >
          {goalRows.map((goal) => (
            <div key={goal.id} className="flex items-center justify-between gap-3">
              <Link href="/goals" className="min-w-0 truncate text-sm font-medium hover:underline">
                {goal.title}
              </Link>
              <StatusChip status={goal.status} />
            </div>
          ))}
        </Section>
      </div>
    </div>
  );
}
