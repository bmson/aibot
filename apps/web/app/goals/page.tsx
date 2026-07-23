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
import { btn, EmptyState, PageHeader, SectionHeading } from '@/lib/ui';
import { archiveInactiveGoals } from './actions';

export const dynamic = 'force-dynamic';

const STATUS_ORDER = ['active', 'paused', 'done', 'abandoned'] as const;
const statusHeadings: Record<(typeof STATUS_ORDER)[number], string> = {
  active: 'In progress',
  paused: 'Paused',
  done: 'Finished',
  abandoned: 'Stopped',
};

function goalIdFromMetadata(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const goalId = (metadata as Record<string, unknown>).goalId;
  return typeof goalId === 'string' ? goalId : undefined;
}

function toGoalView(
  goal: GoalRow,
  now: Date,
  conversationId: string | undefined,
  workActive: boolean,
  automation: { enabled: boolean; nextRunAt: Date | null } | undefined,
  stalled: boolean,
): GoalView {
  const targetDateInput = goal.targetDate ? goal.targetDate.toISOString().slice(0, 10) : '';
  const blockedQuestion = goal.nextAction.startsWith(GOAL_BLOCKED_PREFIX)
    ? goal.nextAction.slice(GOAL_BLOCKED_PREFIX.length).trim()
    : '';
  const blocked =
    goal.status === 'active' && !goal.archivedAt && (blockedQuestion !== '' || stalled);
  return {
    id: goal.id,
    title: goal.title,
    description: goal.description,
    status: goal.status,
    priority: goal.priority,
    progress: goal.progress,
    nextAction: goal.nextAction,
    targetDateInput,
    targetLabel: goal.targetDate
      ? `target ${relativeTime(goal.targetDate, now)} (${targetDateInput})`
      : '',
    updatedLabel: `updated ${relativeTime(goal.updatedAt, now)}`,
    conversationId,
    archived: goal.archivedAt !== null,
    workActive,
    automationLabel:
      goal.status === 'active' && !goal.archivedAt
        ? `Automatic work: ${goalAutomationCadence(goal, now).label}`
        : 'Automatic work is paused',
    automationNextLabel:
      goal.status === 'active' && !goal.archivedAt && automation?.enabled && automation.nextRunAt
        ? `next ${relativeTime(automation.nextRunAt, now)}`
        : '',
    blockedLabel: blocked
      ? `Blocked — needs you: ${blockedQuestion || 'the last automatic session stopped and needs review (see the work chat)'}`
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
  const [rows, chatRows, archivedCountRows, activeTaskRows, automationRows, stalledTaskRows] =
    await Promise.all([
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
  const archivedCount = archivedCountRows[0]?.value ?? 0;
  const automationByGoalId = new Map<string, { enabled: boolean; nextRunAt: Date | null }>();
  for (const goal of rows) {
    const automation = automationRows.find(
      (schedule) => schedule.name === goalScheduleName(goal.id),
    );
    if (automation) automationByGoalId.set(goal.id, automation);
  }
  const groups = STATUS_ORDER.map((status) => ({
    status,
    items: rows.filter((goal) => goal.status === status),
  })).filter((group) => group.items.length > 0);

  return (
    <div className="mx-auto max-w-4xl">
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
              <details className="relative">
                <summary className={`${btn.outline} cursor-pointer list-none`}>More</summary>
                <form
                  action={archiveInactiveGoals}
                  className="absolute top-full right-0 z-10 mt-2 w-64 rounded-lg border border-edge bg-raised p-2 shadow-lg"
                >
                  <button type="submit" className={`${btn.outline} w-full`}>
                    Archive old finished goals
                  </button>
                  <p className="mt-2 px-1 text-xs text-zinc-500">
                    Hides goals finished more than 30 days ago. Their history is kept.
                  </p>
                </form>
              </details>
            </>
          )}
        </div>
      </div>

      {!archived ? <GoalCreateForm /> : null}

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
              <div className="mt-3 flex flex-col gap-3">
                {group.items.map((goal) => (
                  <GoalCard
                    key={`${goal.id}:${goal.updatedAt.getTime()}`}
                    goal={toGoalView(
                      goal,
                      now,
                      chatByGoalId.get(goal.id),
                      activeGoalIds.has(goal.id),
                      automationByGoalId.get(goal.id),
                      stalledGoalIds.has(goal.id),
                    )}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
