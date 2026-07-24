import {
  GOAL_BLOCKED_PREFIX,
  getAgent,
  goalAutomationCadence,
  goalScheduleName,
} from '@assistant/core';
import { conversations, type GoalRow, goals, schedules, tasks } from '@assistant/db';
import { and, asc, count, desc, eq, isNotNull, isNull, notInArray } from 'drizzle-orm';
import Link from 'next/link';
import { GoalCard, type GoalView } from '@/app/goals/goal-card';
import { GoalCreateForm } from '@/app/goals/goal-create-form';
import { requireOwner } from '@/auth';
import { relativeTime } from '@/lib/format';
import { getDb } from '@/lib/server';
import { btn, EmptyState, PageHeader, PageShell, SectionHeading } from '@/lib/ui';
import { ActionMenu, SubmitButton } from '@/lib/ui-client';
import { statusLabel } from '@/lib/views';
import { archiveInactiveGoals } from './actions';

export const metadata = { title: 'Goals' };

export const dynamic = 'force-dynamic';

const STATUS_ORDER = ['active', 'paused', 'done', 'abandoned'] as const;
// Headings match the status chip vocabulary (statusLabel), so a goal is never
// filed under one word and labelled with another.
const statusHeadings: Record<(typeof STATUS_ORDER)[number], string> = {
  active: 'Active',
  paused: 'Paused',
  done: 'Completed',
  abandoned: 'Stopped',
};

function goalIdFromMetadata(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const goalId = (metadata as Record<string, unknown>).goalId;
  return typeof goalId === 'string' ? goalId : undefined;
}

/** "Due Oct 9 — 11w left" / "Due tomorrow" / "Due Oct 9 — 5d overdue". */
function targetMeta(target: Date | null, now: Date): GoalView['targetMeta'] {
  if (!target) return null;
  const days = Math.round((target.getTime() - now.getTime()) / 86_400_000);
  // Targets are stored as UTC dates; format in UTC so "Sep 1" never renders
  // as "Aug 31" in a western timezone.
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    ...(target.getUTCFullYear() === now.getUTCFullYear() ? {} : { year: 'numeric' }),
  }).format(target);
  if (days < 0) return { label: `Due ${date} — ${-days}d overdue`, overdue: true };
  if (days === 0) return { label: 'Due today', overdue: false };
  if (days === 1) return { label: 'Due tomorrow', overdue: false };
  if (days < 15) return { label: `Due ${date} — ${days}d left`, overdue: false };
  return { label: `Due ${date} — ${Math.round(days / 7)}w left`, overdue: false };
}

/** Where "now" sits between the goal's start and its target, 0–100. */
function timelinePct(goal: GoalRow, now: Date): number | null {
  if (!goal.targetDate) return null;
  const start = goal.createdAt.getTime();
  const span = goal.targetDate.getTime() - start;
  if (span <= 0) return null;
  return Math.min(100, Math.max(0, Math.round(((now.getTime() - start) / span) * 100)));
}

function toGoalView(
  goal: GoalRow,
  now: Date,
  conversationId: string | undefined,
  workActive: boolean,
  automation: { enabled: boolean; nextRunAt: Date | null } | undefined,
  stalled: boolean,
  lastSession: { id: string; status: string; updatedAt: Date } | undefined,
): GoalView {
  const targetDateInput = goal.targetDate ? goal.targetDate.toISOString().slice(0, 10) : '';
  const blockedQuestion = goal.nextAction.startsWith(GOAL_BLOCKED_PREFIX)
    ? goal.nextAction.slice(GOAL_BLOCKED_PREFIX.length).trim()
    : '';
  const blocked =
    goal.status === 'active' && !goal.archivedAt && (blockedQuestion !== '' || stalled);
  const isAutomating = goal.status === 'active' && !goal.archivedAt;
  const open = goal.status === 'active' || goal.status === 'paused';
  return {
    id: goal.id,
    title: goal.title,
    description: goal.description,
    status: goal.status,
    priority: goal.priority,
    progress: goal.progress,
    nextAction: goal.nextAction,
    targetDateInput,
    updatedLabel: relativeTime(goal.updatedAt, now),
    conversationId,
    archived: goal.archivedAt !== null,
    workActive,
    paceMeta: isAutomating
      ? `Checks in ${goalAutomationCadence(goal, now).label}`
      : goal.status === 'paused' && !goal.archivedAt
        ? 'Automation paused'
        : '',
    // A healthy-looking countdown under a blocked goal reads as "all fine", so
    // the next-run label stays off while the goal is waiting on the owner.
    automationNextLabel:
      isAutomating && !blocked && automation?.enabled && automation.nextRunAt
        ? `next ${relativeTime(automation.nextRunAt, now)}`
        : '',
    targetMeta: open && !goal.archivedAt ? targetMeta(goal.targetDate, now) : null,
    timelinePct: open && !goal.archivedAt ? timelinePct(goal, now) : null,
    lastSessionLabel: lastSession
      ? `${relativeTime(lastSession.updatedAt, now)} — ${statusLabel(lastSession.status)}`
      : '',
    lastSessionHref: lastSession ? `/tasks/${lastSession.id}` : undefined,
    blockedLabel: blocked
      ? blockedQuestion
        ? `Waiting on you: ${blockedQuestion}`
        : 'Waiting on you — the last session stopped and needs review.'
      : '',
    mirrorToPrimary: goal.mirrorToPrimary,
    autonomy: goal.autonomy,
    taintedOrigin: goal.taintedOrigin,
  };
}

export default async function GoalsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  await requireOwner();
  const { view } = await searchParams;
  const archived = view === 'archived';
  const db = getDb();
  const now = new Date();

  const agent = await getAgent(db);
  const [
    rows,
    chatRows,
    archivedCountRows,
    activeTaskRows,
    automationRows,
    stalledTaskRows,
    sessionRows,
  ] = await Promise.all([
    db
      .select()
      .from(goals)
      .where(
        and(
          eq(goals.agentId, agent.id),
          archived ? isNotNull(goals.archivedAt) : isNull(goals.archivedAt),
        ),
      )
      .orderBy(asc(goals.priority), desc(goals.updatedAt)),
    db
      .select({ id: conversations.id, metadata: conversations.metadata })
      .from(conversations)
      .where(and(eq(conversations.agentId, agent.id), eq(conversations.channel, 'chat')))
      .orderBy(desc(conversations.updatedAt)),
    db
      .select({ value: count() })
      .from(goals)
      .where(and(eq(goals.agentId, agent.id), isNotNull(goals.archivedAt))),
    db
      .selectDistinct({ goalId: tasks.goalId })
      .from(tasks)
      .where(
        and(
          eq(tasks.agentId, agent.id),
          isNotNull(tasks.goalId),
          notInArray(tasks.status, ['done', 'failed', 'cancelled']),
        ),
      ),
    db
      .select({
        name: schedules.name,
        enabled: schedules.enabled,
        nextRunAt: schedules.nextRunAt,
      })
      .from(schedules)
      .where(eq(schedules.agentId, agent.id)),
    db
      .selectDistinct({ goalId: tasks.goalId })
      .from(tasks)
      .where(
        and(
          eq(tasks.agentId, agent.id),
          isNotNull(tasks.goalId),
          eq(tasks.status, 'needs_attention'),
        ),
      ),
    // Most-recent-first; reduced to the latest session per goal below.
    db
      .select({
        goalId: tasks.goalId,
        id: tasks.id,
        status: tasks.status,
        updatedAt: tasks.updatedAt,
      })
      .from(tasks)
      .where(and(eq(tasks.agentId, agent.id), isNotNull(tasks.goalId)))
      .orderBy(desc(tasks.updatedAt)),
  ]);
  const chatByGoalId = new Map<string, string>();
  for (const chat of chatRows) {
    const goalId = goalIdFromMetadata(chat.metadata);
    if (goalId && !chatByGoalId.has(goalId)) chatByGoalId.set(goalId, chat.id);
  }
  const activeGoalIds = new Set(
    activeTaskRows.map((task) => task.goalId).filter((goalId): goalId is string => goalId !== null),
  );
  const stalledGoalIds = new Set(
    stalledTaskRows
      .map((task) => task.goalId)
      .filter((goalId): goalId is string => goalId !== null),
  );
  const lastSessionByGoalId = new Map<string, { id: string; status: string; updatedAt: Date }>();
  for (const session of sessionRows) {
    if (session.goalId && !lastSessionByGoalId.has(session.goalId)) {
      lastSessionByGoalId.set(session.goalId, {
        id: session.id,
        status: session.status,
        updatedAt: session.updatedAt,
      });
    }
  }
  const archivedCount = archivedCountRows[0]?.value ?? 0;
  const automationByGoalId = new Map<string, { enabled: boolean; nextRunAt: Date | null }>();
  for (const goal of rows) {
    const automation = automationRows.find(
      (schedule) => schedule.name === goalScheduleName(goal.id),
    );
    if (automation) automationByGoalId.set(goal.id, automation);
  }
  const cards = rows.map((goal) => ({
    key: `${goal.id}:${goal.updatedAt.getTime()}`,
    status: goal.status,
    view: toGoalView(
      goal,
      now,
      chatByGoalId.get(goal.id),
      activeGoalIds.has(goal.id),
      automationByGoalId.get(goal.id),
      stalledGoalIds.has(goal.id),
      lastSessionByGoalId.get(goal.id),
    ),
  }));
  const groups = STATUS_ORDER.map((status) => ({
    status,
    items: cards.filter((card) => card.status === status),
  })).filter((group) => group.items.length > 0);
  // Goals waiting on the owner lead the Active section — they are the ones a
  // visit to this page can actually unblock.
  for (const group of groups) {
    if (group.status === 'active') {
      group.items.sort(
        (a, b) => Number(b.view.blockedLabel !== '') - Number(a.view.blockedLabel !== ''),
      );
    }
  }

  // One-line digest: what needs the owner, what runs on its own, when the
  // assistant looks at any of it next.
  const activeCards = archived ? [] : cards.filter((card) => card.status === 'active');
  const blockedCount = activeCards.filter((card) => card.view.blockedLabel !== '').length;
  const selfRunningCount = activeCards.length - blockedCount;
  const nextCheckIns = activeCards
    .filter((card) => card.view.blockedLabel === '')
    .map((card) => automationByGoalId.get(card.view.id))
    .filter(
      (automation): automation is { enabled: boolean; nextRunAt: Date } =>
        automation?.enabled === true && automation.nextRunAt !== null && automation.nextRunAt > now,
    )
    .map((automation) => automation.nextRunAt.getTime());
  const nextCheckInLabel =
    nextCheckIns.length > 0 ? relativeTime(new Date(Math.min(...nextCheckIns)), now) : '';

  return (
    <PageShell size="reading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          title={archived ? 'Archived goals' : 'Goals'}
          intro={
            archived
              ? 'Archived goals keep their work chats, tasks, and evidence. Restore one whenever you want to continue.'
              : 'Give the assistant an outcome to keep moving forward. Each goal has its own chat for updates and direction.'
          }
        />
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {archived ? (
            <Link href="/goals" className={btn.outline}>
              Current goals
            </Link>
          ) : (
            <>
              {archivedCount > 0 ? (
                <Link href="/goals?view=archived" className={btn.outline}>
                  Archived ({archivedCount})
                </Link>
              ) : null}
              <ActionMenu label="More" panelClassName="w-64">
                <form action={archiveInactiveGoals}>
                  <SubmitButton pendingLabel="Archiving…" className="w-full">
                    Archive old finished goals
                  </SubmitButton>
                </form>
                <p className="px-1 text-xs text-zinc-500">
                  Hides goals finished more than 30 days ago. Their history is kept.
                </p>
              </ActionMenu>
            </>
          )}
        </div>
      </div>

      {activeCards.length > 0 ? (
        <p className="mt-3 text-[13px] leading-5 text-muted">
          {blockedCount > 0 ? (
            <>
              <span className="font-medium text-amber-700 dark:text-amber-400">
                {blockedCount} waiting on you
              </span>
              {' · '}
            </>
          ) : null}
          {selfRunningCount > 0
            ? `${selfRunningCount} moving on ${selfRunningCount === 1 ? 'its' : 'their'} own`
            : null}
          {selfRunningCount > 0 && nextCheckInLabel ? ' · ' : null}
          {nextCheckInLabel ? `next check-in ${nextCheckInLabel}` : null}
        </p>
      ) : null}

      {!archived ? <GoalCreateForm startOpen={rows.length === 0} /> : null}

      {rows.length === 0 ? (
        <EmptyState>
          {archived
            ? 'No archived goals.'
            : 'No goals yet. Give me an outcome to keep moving — a trip to plan, a search to run — and I check in on it on a schedule.'}
        </EmptyState>
      ) : (
        <div className="mt-8 flex flex-col gap-6">
          {groups.map((group) => (
            <section key={group.status}>
              <SectionHeading title={statusHeadings[group.status]} count={group.items.length} />
              <div className="mt-3 flex flex-col gap-4">
                {group.items.map((card) => (
                  <GoalCard key={card.key} goal={card.view} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </PageShell>
  );
}
