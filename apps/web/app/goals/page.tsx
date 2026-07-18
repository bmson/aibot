import { type GoalRow, goals } from '@assistant/db';
import { asc, desc } from 'drizzle-orm';
import { GoalCard, type GoalView } from '@/app/goals/goal-card';
import { GoalCreateForm } from '@/app/goals/goal-create-form';
import { requireOwner } from '@/auth';
import { relativeTime } from '@/lib/format';
import { getDb } from '@/lib/server';
import { EmptyState, PageHeader, SectionHeading } from '@/lib/ui';

export const dynamic = 'force-dynamic';

const STATUS_ORDER = ['active', 'paused', 'done', 'abandoned'] as const;
const statusHeadings: Record<(typeof STATUS_ORDER)[number], string> = {
  active: 'In progress',
  paused: 'Paused',
  done: 'Finished',
  abandoned: 'Stopped',
};

function toGoalView(goal: GoalRow, now: Date): GoalView {
  const targetDateInput = goal.targetDate ? goal.targetDate.toISOString().slice(0, 10) : '';
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
  };
}

export default async function GoalsPage() {
  await requireOwner();
  const db = getDb();
  const now = new Date();

  const rows = await db.select().from(goals).orderBy(asc(goals.priority), desc(goals.updatedAt));
  const groups = STATUS_ORDER.map((status) => ({
    status,
    items: rows.filter((goal) => goal.status === status),
  })).filter((group) => group.items.length > 0);

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Plans"
        intro="Use a plan for an outcome that takes several steps or needs follow-up. For a one-off request, just ask in Chat."
      />

      <GoalCreateForm />

      {rows.length === 0 ? (
        <EmptyState>
          No plans yet — add one above when you want the assistant to keep an outcome moving over
          time.
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
                    goal={toGoalView(goal, now)}
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
