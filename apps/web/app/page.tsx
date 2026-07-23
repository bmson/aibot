import { evaluateCanaryHealth, getAgent, getMemoryHealth } from '@assistant/core';
import { approvals, canaryRuns, goals, tasks, toolCalls } from '@assistant/db';
import { and, asc, desc, eq, gt, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { ArrowRight, Brain, CircleCheck, CircleX, Clock3, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { ApprovalCard } from '@/app/approvals/approval-card';
import { AutoRefresh } from '@/app/auto-refresh';
import { cancelTask, retryTask } from '@/app/tasks/actions';
import { requireOwner } from '@/auth';
import { relativeTime, stripMarkdown, truncate } from '@/lib/format';
import { getAgentTimezone, getDb, getOwnerFirstName } from '@/lib/server';
import { btn, btnSm, CountBadge, focusRing, PageHeader, PageShell, Panel } from '@/lib/ui';
import { SubmitButton } from '@/lib/ui-client';
import { StatusChip, taskTypeLabel, toPendingApprovalView } from '@/lib/views';

/** "Good morning/afternoon/evening" in the agent's timezone. */
function greetingFor(now: Date, timeZone: string): string {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(now),
  );
  if (Number.isNaN(hour)) return 'Hello';
  if (hour < 5) return 'Up late';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** Scheduled code jobs (memory upkeep, document sweeps) are routine housekeeping — Activity, not Home. */
const notHousekeeping = sql`${tasks.trigger}->'payload'->>'job' IS NULL`;

export const dynamic = 'force-dynamic';

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
  const [tz, ownerFirstName, agent] = await Promise.all([
    getAgentTimezone(),
    getOwnerFirstName(),
    getAgent(db),
  ]);

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
      .where(
        and(
          eq(tasks.agentId, agent.id),
          eq(approvals.status, 'pending'),
          gt(approvals.expiresAt, sql`now()`),
        ),
      )
      .orderBy(asc(approvals.requestedAt)),
    db
      .select()
      .from(tasks)
      .where(and(eq(tasks.agentId, agent.id), eq(tasks.status, 'needs_attention')))
      .orderBy(desc(tasks.updatedAt)),
    db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.agentId, agent.id),
          inArray(tasks.status, [
            'waiting_approval',
            'waiting_event',
            'waiting_budget',
            'sleeping',
          ]),
          notHousekeeping,
        ),
      )
      .orderBy(desc(tasks.updatedAt)),
    db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.agentId, agent.id),
          inArray(tasks.status, ['done', 'failed']),
          isNull(tasks.archivedAt),
          notHousekeeping,
        ),
      )
      .orderBy(desc(tasks.updatedAt))
      .limit(10),
    db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.agentId, agent.id),
          eq(tasks.type, 'mission'),
          notInArray(tasks.status, ['done', 'failed', 'cancelled']),
        ),
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
      .where(and(eq(goals.agentId, agent.id), isNull(goals.archivedAt)))
      .orderBy(asc(goals.priority), desc(goals.updatedAt)),
    db.select().from(canaryRuns).orderBy(desc(canaryRuns.startedAt)).limit(1),
    getMemoryHealth(db, agent.id),
  ]).catch((error: unknown) => {
    console.error('[dashboard] failed to load page data', error);
    return null;
  });
  if (!dashboardData) {
    return (
      <PageShell size="reading">
        <PageHeader title="Home" />
        <p className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-200">
          The dashboard is having trouble loading live data right now. The app shell is still up,
          and we are treating this as a data-layer failure rather than a full outage.
        </p>
      </PageShell>
    );
  }
  const [
    pendingApprovals,
    attention,
    waiting,
    recentDone,
    missions,
    goalRows,
    [latestCanary],
    memoryHealth,
  ] = dashboardData;
  const canaryHealth = evaluateCanaryHealth(latestCanary, { now });
  const failedCanaryChecks = Object.entries(
    (latestCanary?.checks ?? {}) as Record<string, { ok?: boolean }>,
  )
    .filter(([, check]) => check.ok === false)
    .map(([name]) => canaryLabels[name] ?? name.replaceAll('_', ' '));
  const showServiceWarning = canaryHealth.state === 'failed' || canaryHealth.state === 'stale';

  const needsYou = pendingApprovals.length + attention.length;

  const visibleAttention = attention.slice(0, 3);
  const inMotionPreviewSlots = Math.max(0, 3 - visibleAttention.length);
  const visibleWaiting = waiting.slice(0, inMotionPreviewSlots);
  const visibleMissions = missions.slice(
    0,
    Math.max(0, inMotionPreviewSlots - visibleWaiting.length),
  );
  const inMotionCount = waiting.length + missions.length;
  const visibleInMotionCount = visibleWaiting.length + visibleMissions.length;
  const visibleResults = recentDone.slice(0, 4);
  const visibleGoals = goalRows.slice(0, 3);

  return (
    <PageShell>
      <AutoRefresh />
      <div className="flex flex-wrap items-start justify-between gap-5">
        <PageHeader
          title={
            ownerFirstName ? `${greetingFor(now, tz)}, ${ownerFirstName}` : greetingFor(now, tz)
          }
          intro="A short briefing on what needs you, what is moving, and what changed."
        />
        <Link href="/chat" className={`${btn.primary} mt-1`}>
          <Sparkles className="size-4" aria-hidden="true" />
          Ask AI Bot
        </Link>
      </div>
      {showServiceWarning ? (
        <section className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900/60 dark:bg-amber-950/20">
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

      <div className="mt-8 grid gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(18rem,0.65fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <Panel>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-semibold tracking-[-0.02em]">Needs you</h2>
                  {needsYou > 0 ? <CountBadge tone="amber">{needsYou}</CountBadge> : null}
                </div>
                <p className="mt-1 text-[13px] leading-5 text-muted">
                  Decisions that keep work moving.
                </p>
              </div>
              {needsYou > 0 ? (
                <Link
                  href={pendingApprovals.length > 0 ? '/approvals' : '/tasks?filter=needs-you'}
                  className={`inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:underline ${focusRing}`}
                >
                  Review all
                  <ArrowRight className="size-3.5" aria-hidden="true" />
                </Link>
              ) : null}
            </div>

            {needsYou === 0 ? (
              <div className="mt-5 flex items-center gap-3 rounded-xl bg-sunken/55 p-4">
                <CircleCheck
                  className="size-5 shrink-0 text-emerald-600 dark:text-emerald-400"
                  aria-hidden="true"
                />
                <p className="text-[15px] text-muted">
                  You’re caught up. AI Bot will ask when it needs a decision.
                </p>
              </div>
            ) : null}

            {pendingApprovals[0] ? (
              <div className="mt-5">
                <p className="mb-2 text-xs font-semibold tracking-[0.1em] text-muted uppercase">
                  Oldest approval
                </p>
                {(() => {
                  const { approval, taskType, taskTrust, toolName, decision } = pendingApprovals[0];
                  return (
                    <ApprovalCard
                      approval={toPendingApprovalView(
                        approval,
                        { type: taskType, trust: taskTrust },
                        { toolName, decision },
                        now,
                        tz,
                      )}
                      compact
                    />
                  );
                })()}
                {pendingApprovals.length > 1 ? (
                  <p className="mt-3 text-[13px] text-muted">
                    {pendingApprovals.length - 1} more waiting in{' '}
                    <Link href="/approvals" className="font-medium text-accent hover:underline">
                      Approvals
                    </Link>
                    .
                  </p>
                ) : null}
              </div>
            ) : null}

            {visibleAttention.length > 0 ? (
              <div
                className={pendingApprovals.length > 0 ? 'mt-5 border-t border-edge pt-5' : 'mt-5'}
              >
                <p className="mb-2 text-xs font-semibold tracking-[0.1em] text-muted uppercase">
                  Blocked work
                </p>
                <div className="flex flex-col gap-2">
                  {visibleAttention.map((task) => (
                    <div
                      key={task.id}
                      data-home-work-preview="true"
                      className="flex flex-col gap-3 rounded-xl bg-amber-50/70 p-3.5 sm:flex-row sm:items-center sm:justify-between dark:bg-amber-950/20"
                    >
                      <div className="min-w-0">
                        <Link
                          href={`/tasks/${task.id}`}
                          className="text-[15px] font-medium hover:underline"
                        >
                          {task.title || taskTypeLabel(task.type)}
                        </Link>
                        <p className="mt-0.5 line-clamp-2 text-[13px] leading-5 text-muted">
                          {stripMarkdown(task.progress) || 'No update recorded yet.'}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <form action={retryTask.bind(null, task.id)}>
                          <SubmitButton pendingLabel="Retrying…" className={btnSm.outline}>
                            Retry
                          </SubmitButton>
                        </form>
                        <form action={cancelTask.bind(null, task.id)}>
                          <SubmitButton pendingLabel="Cancelling…" className={btnSm.outline}>
                            Cancel
                          </SubmitButton>
                        </form>
                      </div>
                    </div>
                  ))}
                </div>
                {attention.length > visibleAttention.length ? (
                  <p className="mt-3 text-[13px] text-muted">
                    {attention.length - visibleAttention.length} more blocked item
                    {attention.length - visibleAttention.length === 1 ? '' : 's'} in{' '}
                    <Link
                      href="/tasks?filter=needs-you"
                      className="font-medium text-accent hover:underline"
                    >
                      Activity
                    </Link>
                    .
                  </p>
                ) : null}
              </div>
            ) : null}
          </Panel>

          <Panel>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <Clock3 className="size-4 text-accent" aria-hidden="true" />
                  <h2 className="text-lg font-semibold tracking-[-0.02em]">In motion</h2>
                </div>
                <p className="mt-1 text-[13px] leading-5 text-muted">
                  Work continuing without another decision from you.
                </p>
              </div>
              <Link
                href="/tasks?filter=working"
                className="text-[13px] font-medium text-accent hover:underline"
              >
                Activity
              </Link>
            </div>
            {inMotionCount === 0 ? (
              <p className="mt-5 text-[15px] text-muted">Nothing is running or scheduled.</p>
            ) : visibleInMotionCount === 0 ? (
              <p className="mt-5 text-[15px] leading-6 text-muted">
                {inMotionCount} item{inMotionCount === 1 ? '' : 's'} continue quietly. Blocked work
                takes priority in today’s preview.
              </p>
            ) : (
              <div className="mt-5 divide-y divide-edge">
                {visibleWaiting.map((task) => {
                  const line =
                    task.status === 'sleeping'
                      ? task.runAfter
                        ? `Next check ${relativeTime(task.runAfter, now)}`
                        : 'Its next check is being scheduled.'
                      : (waitingLine[task.status] ?? task.status);
                  return (
                    <div
                      key={task.id}
                      data-home-work-preview="true"
                      className="grid gap-2 py-3 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                    >
                      <div className="min-w-0">
                        <Link
                          href={`/tasks/${task.id}`}
                          className="text-[15px] font-medium hover:underline"
                        >
                          {task.title || taskTypeLabel(task.type)}
                        </Link>
                        <p className="mt-0.5 line-clamp-2 text-[13px] leading-5 text-muted">
                          {line}
                        </p>
                      </div>
                      <StatusChip status={task.status} />
                    </div>
                  );
                })}
                {visibleMissions.map((task) => (
                  <div
                    key={task.id}
                    data-home-work-preview="true"
                    className="grid gap-2 py-3 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                  >
                    <div className="min-w-0">
                      <Link
                        href={`/tasks/${task.id}`}
                        className="text-[15px] font-medium hover:underline"
                      >
                        {task.title ||
                          truncate(stripMarkdown(task.progress || task.nextAction), 80) ||
                          'Ongoing work'}
                      </Link>
                      <p className="mt-0.5 line-clamp-2 text-[13px] leading-5 text-muted">
                        {task.nextAction ||
                          task.progress ||
                          'The assistant will post an update here.'}
                      </p>
                    </div>
                    <StatusChip status={task.status} />
                  </div>
                ))}
              </div>
            )}
            {visibleInMotionCount > 0 && inMotionCount > visibleInMotionCount ? (
              <p className="mt-4 border-t border-edge pt-4 text-[13px] text-muted">
                {inMotionCount - visibleInMotionCount} more item
                {inMotionCount - visibleInMotionCount === 1 ? '' : 's'} continue quietly in
                Activity.
              </p>
            ) : null}
          </Panel>
        </div>

        <aside className="flex min-w-0 flex-col gap-5">
          <Panel tone="sunken" className="motion-safe:animate-[presence-arrive_320ms_ease-out]">
            <div className="flex items-center gap-2">
              <Brain className="size-4 text-accent" aria-hidden="true" />
              <h2 className="text-[15px] font-semibold">Memory care</h2>
            </div>
            <p className="mt-4 text-lg leading-7 font-medium tracking-[-0.02em]">
              {memoryHealth.notYetOrganized === 0
                ? 'Memory is caught up.'
                : `${memoryHealth.notYetOrganized} memor${
                    memoryHealth.notYetOrganized === 1 ? 'y is' : 'ies are'
                  } waiting for a cleanup pass.`}
            </p>
            <div className="mt-4 grid grid-cols-3 gap-3 border-t border-edge pt-4">
              <Link href="/profile/memories?view=available" className="group">
                <p className="text-base font-semibold">{memoryHealth.totalUsable}</p>
                <p className="text-xs text-muted group-hover:text-strong">available</p>
              </Link>
              <Link href="/profile/memories?view=review" className="group">
                <p className="text-base font-semibold">{memoryHealth.awaitingReview}</p>
                <p className="text-xs text-muted group-hover:text-strong">needs review</p>
              </Link>
              <Link href="/profile/memories?view=verified" className="group">
                <p className="text-base font-semibold">{memoryHealth.ownerConfirmed}</p>
                <p className="text-xs text-muted group-hover:text-strong">verified by you</p>
              </Link>
            </div>
            <Link
              href="/profile"
              className="mt-4 inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:underline"
            >
              Open memory desk
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </Link>
          </Panel>

          <Panel>
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-[15px] font-semibold">Latest outcomes</h2>
              <Link
                href="/tasks?filter=completed"
                className="text-[13px] font-medium text-accent hover:underline"
              >
                See all
              </Link>
            </div>
            {visibleResults.length === 0 ? (
              <p className="mt-4 text-[13px] leading-5 text-muted">No finished work yet.</p>
            ) : (
              <div className="mt-4 flex flex-col gap-3">
                {visibleResults.map((task) => (
                  <div key={task.id} className="flex items-start gap-2.5">
                    {task.status === 'done' ? (
                      <CircleCheck
                        className="mt-0.5 size-4 shrink-0 text-emerald-600"
                        aria-hidden="true"
                      />
                    ) : (
                      <CircleX className="mt-0.5 size-4 shrink-0 text-red-500" aria-hidden="true" />
                    )}
                    <div className="min-w-0">
                      <Link
                        href={`/tasks/${task.id}`}
                        className="line-clamp-1 text-[13px] font-medium hover:underline"
                      >
                        {task.title || taskTypeLabel(task.type)}
                      </Link>
                      <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted">
                        {stripMarkdown(task.progress) || relativeTime(task.updatedAt, now)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          {visibleGoals.length > 0 ? (
            <Panel>
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-[15px] font-semibold">Goals</h2>
                <Link href="/goals" className="text-[13px] font-medium text-accent hover:underline">
                  Open goals
                </Link>
              </div>
              <div className="mt-4 flex flex-col gap-3">
                {visibleGoals.map((goal) => (
                  <div key={goal.id} className="flex items-center justify-between gap-3">
                    <Link
                      href={`/goals#goal-${goal.id}`}
                      className="min-w-0 line-clamp-1 text-[13px] font-medium hover:underline"
                    >
                      {goal.title}
                    </Link>
                    <StatusChip status={goal.status} />
                  </div>
                ))}
              </div>
            </Panel>
          ) : null}
        </aside>
      </div>
      <p className="mt-6 text-xs text-muted">
        Routine housekeeping (memory upkeep, document processing) runs quietly on schedule — find it
        under{' '}
        <Link href="/tasks" className="underline hover:no-underline">
          Activity
        </Link>
        .
      </p>
    </PageShell>
  );
}
