'use server';

import {
  encodeMessageCursor,
  enqueueTask,
  ensureGoalAutomation,
  getAgent,
  getQueueNotifier,
} from '@assistant/core';
import { conversations, type Db, type GoalRow, goals, tasks } from '@assistant/db';
import { and, eq, inArray, isNotNull, isNull, lt, notInArray } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireOwner } from '@/auth';
import { getDb } from '@/lib/server';

const GOAL_STATUSES = ['active', 'paused', 'done', 'abandoned'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];
const TERMINAL_TASK_STATUSES = ['done', 'failed', 'cancelled'];
const ARCHIVE_AFTER_DAYS = 30;

export interface GoalFormState {
  error: string | null;
  /** Submitted fields echoed back on error — React resets the form after every action. */
  values?: Record<string, string>;
}

const FORM_FIELDS = ['title', 'description', 'priority', 'targetDate', 'progress', 'nextAction'];

function field(formData: FormData, name: string): string {
  return String(formData.get(name) ?? '').trim();
}

function echo(formData: FormData): Record<string, string> {
  return Object.fromEntries(FORM_FIELDS.map((name) => [name, field(formData, name)]));
}

interface ParsedGoalForm {
  title: string;
  description: string;
  priority: number;
  targetDate: Date | null;
  progress: string;
  nextAction: string;
  mirrorToPrimary: boolean;
}

function parseGoalForm(formData: FormData): { form: ParsedGoalForm } | { error: string } {
  const title = field(formData, 'title');
  if (!title) return { error: 'Title is required.' };

  const priority = Number.parseInt(field(formData, 'priority') || '3', 10);
  if (!Number.isInteger(priority) || priority < 1 || priority > 5) {
    return { error: 'Priority must be between 1 and 5.' };
  }

  const rawDate = field(formData, 'targetDate');
  let targetDate: Date | null = null;
  if (rawDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) return { error: 'Target date must be YYYY-MM-DD.' };
    targetDate = new Date(`${rawDate}T00:00:00Z`);
    if (Number.isNaN(targetDate.getTime())) return { error: 'Target date is not a valid date.' };
  }

  return {
    form: {
      title,
      description: field(formData, 'description'),
      priority,
      targetDate,
      progress: field(formData, 'progress'),
      nextAction: field(formData, 'nextAction'),
      mirrorToPrimary: formData.get('mirrorToPrimary') != null,
    },
  };
}

function revalidateGoalViews(): void {
  revalidatePath('/');
  revalidatePath('/goals');
  revalidatePath('/settings');
}

type WorkGoal = Pick<GoalRow, 'id' | 'title' | 'description' | 'targetDate'>;

function openingWorkMessage(goal: WorkGoal): string {
  return [
    `Start working on my goal: ${goal.title}`,
    goal.description ? `Context: ${goal.description}` : '',
    goal.targetDate ? `Target date: ${goal.targetDate.toISOString().slice(0, 10)}` : '',
    'Take one useful, concrete step now. This goal will keep running on its automation cadence; use this chat to guide the work. If you need information or approval, say exactly what you need. Do not create an additional mission or schedule.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Goals are outcomes, not inert notes. This writes the linked chat, its first
 * owner request, and a runnable task in the same transaction. The queue poke
 * deliberately happens only after commit; the periodic sweeper remains the
 * recovery path if a notification is lost.
 */
async function createGoalWork(
  db: Db,
  agentId: string,
  goal: WorkGoal,
): Promise<{
  conversationId: string;
  taskId: string;
  taskGeneration: number;
  messageCursor: string;
}> {
  const messageText = openingWorkMessage(goal);
  const [conversation] = await db
    .insert(conversations)
    .values({
      agentId,
      channel: 'chat',
      trust: 'owner',
      title: `Work: ${goal.title}`.slice(0, 120),
      metadata: { goalId: goal.id },
    })
    .returning();
  if (!conversation) throw new Error('failed to create work chat');

  const { task } = await enqueueTask(db, {
    event: {
      source: 'chat',
      agentId,
      conversationId: conversation.id,
      trust: 'owner',
      payload: { text: messageText, goalId: goal.id, createdFrom: 'goal' },
    },
    type: 'chat_turn',
    goalId: goal.id,
    // Do not let a worker run against a goal/chat/message set that has not
    // committed yet. The caller notifies immediately after the transaction.
    deferNotification: true,
  });

  return {
    conversationId: conversation.id,
    taskId: task.id,
    taskGeneration: task.queueGeneration,
    // The opening instruction is an internal task trigger, not something the
    // owner typed. Start polling just after the task was created so the work
    // chat opens cleanly and only shows real owner/assistant messages.
    messageCursor: encodeMessageCursor({ createdAt: task.createdAt, id: task.id }),
  };
}

function notifyWorkTask(taskId: string, generation: number): void {
  try {
    getQueueNotifier().notify(taskId, generation);
  } catch (error) {
    // The task is durable and the scheduler will claim it. Do not make the
    // owner retry and accidentally create a second goal just because the
    // best-effort queue notification is temporarily misconfigured.
    console.error('goal work task queued without an immediate notification', error);
  }
}

function workChatUrl(work: {
  conversationId: string;
  taskId: string;
  messageCursor: string;
}): string {
  const query = new URLSearchParams({ task: work.taskId, cursor: work.messageCursor });
  return `/chat/${work.conversationId}?${query.toString()}`;
}

export async function createGoal(_prev: GoalFormState, formData: FormData): Promise<GoalFormState> {
  await requireOwner();
  const parsed = parseGoalForm(formData);
  if ('error' in parsed) return { error: parsed.error, values: echo(formData) };

  const db = getDb();
  const agent = await getAgent(db);
  const work = await db.transaction(async (tx) => {
    const [goal] = await tx
      .insert(goals)
      .values({
        agentId: agent.id,
        ...parsed.form,
        progress: 'First task queued.',
        nextAction: 'Check the work chat for the first update.',
      })
      .returning();
    if (!goal) throw new Error('failed to create goal');
    const work = await createGoalWork(tx as unknown as Db, agent.id, goal);
    await ensureGoalAutomation(tx as unknown as Db, agent, goal, work.conversationId);
    return work;
  });

  revalidateGoalViews();
  notifyWorkTask(work.taskId, work.taskGeneration);
  redirect(workChatUrl(work));
}

/** Start the same one-off work flow for an older goal that predates linked chats. */
export async function startGoalWork(goalId: string): Promise<void> {
  await requireOwner();
  const db = getDb();
  const agent = await getAgent(db);
  const [goal] = await db
    .select()
    .from(goals)
    .where(and(eq(goals.id, goalId), eq(goals.agentId, agent.id), isNull(goals.archivedAt)));
  if (!goal) throw new Error('goal not found or is archived');

  const work = await db.transaction(async (tx) => {
    const started = await createGoalWork(tx as unknown as Db, agent.id, goal);
    await ensureGoalAutomation(tx as unknown as Db, agent, goal, started.conversationId);
    return started;
  });
  revalidateGoalViews();
  notifyWorkTask(work.taskId, work.taskGeneration);
  redirect(workChatUrl(work));
}

export async function updateGoal(_prev: GoalFormState, formData: FormData): Promise<GoalFormState> {
  await requireOwner();
  const goalId = String(formData.get('goalId') ?? '');
  if (!goalId) return { error: 'Missing goal id.', values: echo(formData) };

  const parsed = parseGoalForm(formData);
  if ('error' in parsed) return { error: parsed.error, values: echo(formData) };

  const db = getDb();
  const agent = await getAgent(db);
  const [goal] = await db
    .update(goals)
    .set({ ...parsed.form, updatedAt: new Date() })
    .where(and(eq(goals.id, goalId), eq(goals.agentId, agent.id)))
    .returning();
  if (goal) await ensureGoalAutomation(db, agent, goal);

  revalidateGoalViews();
  return { error: null };
}

/** Pause/Resume, Mark done, Abandon — the two-click abandon confirm lives in the card. */
export async function setGoalStatus(goalId: string, status: GoalStatus): Promise<void> {
  await requireOwner();
  if (!GOAL_STATUSES.includes(status)) throw new Error(`invalid goal status: ${String(status)}`);
  const db = getDb();
  const agent = await getAgent(db);
  const [goal] = await db
    .update(goals)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(goals.id, goalId), eq(goals.agentId, agent.id)))
    .returning();
  if (goal) await ensureGoalAutomation(db, agent, goal);
  revalidateGoalViews();
}

async function requireArchivableGoal(goalId: string) {
  const db = getDb();
  const agent = await getAgent(db);
  const [goal] = await db
    .select({ goal: goals })
    .from(goals)
    .where(and(eq(goals.id, goalId), eq(goals.agentId, agent.id)))
    .limit(1);
  if (!goal) throw new Error('goal not found');

  const [activeTask] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.agentId, agent.id),
        eq(tasks.goalId, goal.goal.id),
        notInArray(tasks.status, TERMINAL_TASK_STATUSES),
      ),
    )
    .limit(1);
  if (activeTask)
    throw new Error('finish, cancel, or pause active work before archiving this goal');
  return { db, agent, goal: goal.goal };
}

/** Hide a goal from the daily view without deleting its chat, tasks, or evidence. */
export async function archiveGoal(goalId: string): Promise<void> {
  await requireOwner();
  const { db, agent, goal } = await requireArchivableGoal(goalId);
  const [archived] = await db
    .update(goals)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(goals.id, goal.id), isNull(goals.archivedAt)))
    .returning();
  if (archived) await ensureGoalAutomation(db, agent, archived);
  revalidateGoalViews();
  redirect('/goals');
}

/** Return a goal to the daily view. Its status and all prior work are preserved. */
export async function restoreGoal(goalId: string): Promise<void> {
  await requireOwner();
  const db = getDb();
  const agent = await getAgent(db);
  const [goal] = await db
    .select({ id: goals.id })
    .from(goals)
    .where(and(eq(goals.id, goalId), eq(goals.agentId, agent.id)))
    .limit(1);
  if (!goal) throw new Error('goal not found');
  const [restored] = await db
    .update(goals)
    .set({ archivedAt: null, updatedAt: new Date() })
    .where(and(eq(goals.id, goal.id), isNotNull(goals.archivedAt)))
    .returning();
  if (restored) await ensureGoalAutomation(db, agent, restored);
  revalidateGoalViews();
  redirect('/goals');
}

/** A safe tidy-up for long-finished goals. Current work is never hidden. */
export async function archiveInactiveGoals(): Promise<void> {
  await requireOwner();
  const db = getDb();
  const agent = await getAgent(db);
  const cutoff = new Date(Date.now() - ARCHIVE_AFTER_DAYS * 24 * 60 * 60 * 1000);
  const candidates = await db
    .select({ goal: goals })
    .from(goals)
    .where(
      and(
        eq(goals.agentId, agent.id),
        isNull(goals.archivedAt),
        inArray(goals.status, ['done', 'abandoned']),
        lt(goals.updatedAt, cutoff),
      ),
    )
    .limit(100);

  for (const candidate of candidates) {
    const [activeTask] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.agentId, agent.id),
          eq(tasks.goalId, candidate.goal.id),
          notInArray(tasks.status, TERMINAL_TASK_STATUSES),
        ),
      )
      .limit(1);
    if (activeTask) continue;
    const [archived] = await db
      .update(goals)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(goals.id, candidate.goal.id), isNull(goals.archivedAt)))
      .returning();
    if (archived) await ensureGoalAutomation(db, agent, archived);
  }
  revalidateGoalViews();
  redirect('/goals');
}
