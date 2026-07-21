import type { Db, TaskRow } from '@assistant/db';
import { goals } from '@assistant/db';
import { eq, sql } from 'drizzle-orm';
import { persistMessage } from '../../chat.js';
import { GOAL_BLOCKED_PREFIX } from '../schedules.js';
import type { ExecutorDeps } from './types.js';

/** Parked/paused tasks with a conversation must say so in the thread, not go silent. */
export async function postConversationNotice(
  db: Db,
  task: TaskRow,
  text: string,
  extraParts: unknown[] = [],
): Promise<void> {
  if (!task.conversationId) return;
  await persistMessage(db, {
    conversationId: task.conversationId,
    taskId: task.id,
    role: 'assistant',
    origin: 'assistant',
    parts: [{ type: 'text', text }, ...extraParts],
    text,
  }).catch((err) => console.error('conversation notice failed', err));
}

/**
 * Post the dashboard notice AND push it to the owner's channel for events that
 * would otherwise only be visible by opening the dashboard (permanent failure,
 * budget stall). Owner ping is best-effort: a delivery failure must never mask
 * the underlying task outcome.
 */
export async function notifyOwnerAndConversation(
  deps: ExecutorDeps,
  task: TaskRow,
  text: string,
  extraParts: unknown[] = [],
): Promise<void> {
  await postConversationNotice(deps.db, task, text, extraParts);
  if (deps.notifyOwner) {
    await deps
      .notifyOwner({ taskId: task.id, conversationId: task.conversationId, text })
      .catch((err) => console.error('owner notification failed', err));
  }
}

/** Runtime-owned budget request; the model never chooses or applies the cap. */
export function taskBudgetPermissionRequest(task: TaskRow, reason: string) {
  const currentBudgetUsd = Number(task.budgetUsdLimit);
  const spentUsd = Number(task.spentUsd);
  const estimatedUsd = Number(reason.match(/est \$([0-9]+(?:\.[0-9]+)?)/)?.[1] ?? 0);
  const proposedBudgetUsd =
    Math.ceil(Math.max(currentBudgetUsd * 2, spentUsd + estimatedUsd) * 4) / 4;
  const text = `I need your permission to raise this task's spending limit from $${currentBudgetUsd.toFixed(2)} to $${proposedBudgetUsd.toFixed(2)} so I can finish. I've spent $${spentUsd.toFixed(4)} so far. Approve the increase in chat or Activity, or decline to stop this task. I won't increase the budget without your approval.`;
  return {
    text,
    part: {
      type: 'budget-request',
      taskId: task.id,
      currentBudgetUsd,
      proposedBudgetUsd,
      spentUsd,
      reason,
    },
  } as const;
}

/**
 * Park the goal itself, not just the task. goalInstruction() re-seeds every
 * session from these columns, so an unanswered question has to land here or
 * tomorrow's run starts from the same stale line and asks all over again.
 */
export async function recordGoalBlocked(db: Db, goalId: string, question: string): Promise<void> {
  await db
    .update(goals)
    .set({
      nextAction: `${GOAL_BLOCKED_PREFIX} ${question}`.slice(0, 500),
      updatedAt: sql`now()`,
    })
    .where(eq(goals.id, goalId));
}
