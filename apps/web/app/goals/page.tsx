import { getAgent } from '@assistant/core';
import { conversations, type GoalRow, goals } from '@assistant/db';
import { and, asc, desc, eq } from 'drizzle-orm';
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

function goalIdFromMetadata(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const goalId = (metadata as Record<string, unknown>).goalId;
  return typeof goalId === 'string' ? goalId : undefined;
}

function toGoalView(goal: GoalRow, now: Date, conversationId?: string): GoalView {
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
    conversationId,
  };
}

export default async function GoalsPage() {
  await requireOwner();
  const db = getDb();
  const now = new Date();

  const agent = await getAgent(db);
  const [rows, chatRows] = await Promise.all([
    db
      .select()
      .from(goals)
      .where(eq(goals.agentId, agent.id))
      .orderBy(asc(goals.priority), desc(goals.updatedAt)),
    db
      .select({ id: conversations.id, metadata: conversations.metadata })
      .from(conversations)
      .where(and(eq(conversations.agentId, agent.id), eq(conversations.channel, 'chat')))
      .orderBy(desc(conversations.updatedAt)),
  ]);
  const chatByGoalId = new Map<string, string>();
  for (const chat of chatRows) {
    const goalId = goalIdFromMetadata(chat.metadata);
    if (goalId && !chatByGoalId.has(goalId)) chatByGoalId.set(goalId, chat.id);
  }
  const groups = STATUS_ORDER.map((status) => ({
    status,
    items: rows.filter((goal) => goal.status === status),
  })).filter((group) => group.items.length > 0);

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Goals"
        intro="A goal is an outcome you want to move forward. Creating one starts a work chat and one concrete task; ask in that chat if you want ongoing work."
      />

      <GoalCreateForm />

      {rows.length === 0 ? (
        <EmptyState>
          No goals yet — create one above when you want to start an outcome with a real task.
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
                    goal={toGoalView(goal, now, chatByGoalId.get(goal.id))}
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
