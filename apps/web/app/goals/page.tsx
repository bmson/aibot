import { type GoalRow, goals } from '@assistant/db';
import { asc, desc } from 'drizzle-orm';
import { GoalCard, type GoalView } from '@/app/goals/goal-card';
import { GoalCreateForm } from '@/app/goals/goal-create-form';
import { requireOwner } from '@/auth';
import { relativeTime } from '@/lib/format';
import { getDb } from '@/lib/server';

export const dynamic = 'force-dynamic';

const STATUS_ORDER = ['active', 'paused', 'done', 'abandoned'] as const;

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
      <h1 className="text-xl font-semibold">Goals</h1>
      <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
        Long-running objectives the assistant plans toward and reports progress on.
      </p>

      <GoalCreateForm />

      {rows.length === 0 ? (
        <p className="mt-8 text-sm text-zinc-500 dark:text-zinc-400">
          No goals yet — add one above to give the assistant a long-running objective.
        </p>
      ) : (
        <div className="mt-8 flex flex-col gap-6">
          {groups.map((group) => (
            <section key={group.status}>
              <h2 className="flex items-baseline gap-2 text-sm font-medium capitalize">
                {group.status}
                <span className="text-xs font-normal text-zinc-500 dark:text-zinc-500">
                  {group.items.length}
                </span>
              </h2>
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
