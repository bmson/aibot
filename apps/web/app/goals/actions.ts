'use server';

import { getAgent } from '@assistant/core';
import { goals } from '@assistant/db';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/auth';
import { getDb } from '@/lib/server';

const GOAL_STATUSES = ['active', 'paused', 'done', 'abandoned'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

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
    },
  };
}

function revalidateGoalViews(): void {
  revalidatePath('/');
  revalidatePath('/goals');
}

export async function createGoal(_prev: GoalFormState, formData: FormData): Promise<GoalFormState> {
  await requireOwner();
  const parsed = parseGoalForm(formData);
  if ('error' in parsed) return { error: parsed.error, values: echo(formData) };

  const db = getDb();
  const agent = await getAgent(db);
  await db.insert(goals).values({ agentId: agent.id, ...parsed.form });

  revalidateGoalViews();
  return { error: null };
}

export async function updateGoal(_prev: GoalFormState, formData: FormData): Promise<GoalFormState> {
  await requireOwner();
  const goalId = String(formData.get('goalId') ?? '');
  if (!goalId) return { error: 'Missing goal id.', values: echo(formData) };

  const parsed = parseGoalForm(formData);
  if ('error' in parsed) return { error: parsed.error, values: echo(formData) };

  await getDb()
    .update(goals)
    .set({ ...parsed.form, updatedAt: new Date() })
    .where(eq(goals.id, goalId));

  revalidateGoalViews();
  return { error: null };
}

/** Pause/Resume, Mark done, Abandon — the two-click abandon confirm lives in the card. */
export async function setGoalStatus(goalId: string, status: GoalStatus): Promise<void> {
  await requireOwner();
  if (!GOAL_STATUSES.includes(status)) throw new Error(`invalid goal status: ${String(status)}`);
  await getDb().update(goals).set({ status, updatedAt: new Date() }).where(eq(goals.id, goalId));
  revalidateGoalViews();
}
