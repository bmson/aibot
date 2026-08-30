import type { Db, TaskRow } from '@assistant/db';
import { goals } from '@assistant/db';
import { eq, sql } from 'drizzle-orm';
import { persistMessage } from '../../chat.js';
import { compactChatMessageParts } from '../../chat-card.js';
import { markAttentionNotified } from '../machine.js';
import { GOAL_BLOCKED_PREFIX } from '../schedules.js';
import type { ExecutorDeps } from './types.js';

/**
 * Kinds of notice the chat renders as a card rather than as assistant prose.
 * `parked` is "I stopped and will resume on my own"; `needs-attention` is "I
 * stopped and cannot continue without you". Both are things the owner has to
 * read and act on, so neither should look like conversation.
 */
export type NoticeKind = 'parked' | 'needs-attention';

/**
 * Add the structured marker that makes the chat render a notice as a card
 * rather than as assistant prose. Same shape assistantMessageParts already uses
 * for the response-contract notice (packages/core/src/chat.ts); `parts` is
 * jsonb, so this is additive — messages written before the marker existed carry
 * none and keep rendering as prose. The web app matches these kinds in
 * apps/web/lib/chat-notices.ts.
 *
 * A message that already carries something which speaks for itself is left
 * alone: another notice kind the caller chose, or a decision part (an approval,
 * a spending request) whose own card already says what is waiting. Two markers
 * on one message would leave the interface picking which to believe.
 */
const SELF_DESCRIBING = new Set(['notice', 'approval', 'budget-request', 'suggestion']);

/**
 * Decision parts (approval rows, a spending request) render as their own
 * cards, so a text part carrying the same sentences would render the decision
 * twice. New rows leave the prose out of `parts` entirely — it lives on in
 * the message's `text` column, which is what model history, embeddings, and
 * channel bodies read. Rows written before this change keep both; the chat's
 * isDecisionProseNotice filter covers those.
 */
const CARD_ONLY_PARTS = new Set(['approval', 'budget-request']);

function carriesOwnCard(extraParts: unknown[]): boolean {
  return extraParts.some((part) => {
    if (!part || typeof part !== 'object') return false;
    const type = (part as { type?: unknown }).type;
    return typeof type === 'string' && CARD_ONLY_PARTS.has(type);
  });
}

export function noticeParts(kind: NoticeKind, extraParts: unknown[] = []): unknown[] {
  const speaksForItself = extraParts.some((part) => {
    if (!part || typeof part !== 'object') return false;
    const type = (part as { type?: unknown }).type;
    return typeof type === 'string' && SELF_DESCRIBING.has(type);
  });
  return speaksForItself ? extraParts : [...extraParts, { type: 'notice', notice: kind }];
}

/**
 * Parked/paused tasks with a conversation must say so in the thread, not go
 * silent. Returns whether a row was actually persisted so callers can tell
 * whether the owner has any chance of seeing this (used by the re-notify sweep).
 */
export async function postConversationNotice(
  db: Db,
  task: TaskRow,
  text: string,
  extraParts: unknown[] = [],
): Promise<boolean> {
  if (!task.conversationId) return false;
  try {
    await persistMessage(db, {
      conversationId: task.conversationId,
      taskId: task.id,
      role: 'assistant',
      origin: 'assistant',
      // A decision card speaks for itself: no duplicated prose part. The prose
      // still lands in `text` (model history and channel bodies read that).
      parts: carriesOwnCard(extraParts)
        ? extraParts
        : compactChatMessageParts(text, [{ type: 'text', text }, ...extraParts], task.id),
      text,
    });
    return true;
  } catch (err) {
    console.error('conversation notice failed', err);
    return false;
  }
}

/**
 * Post the dashboard notice AND push it to the owner's channel for events that
 * would otherwise only be visible by opening the dashboard (permanent failure,
 * budget stall). Owner ping is best-effort: a delivery failure must never mask
 * the underlying task outcome. Returns which legs succeeded.
 */
export async function notifyOwnerAndConversation(
  deps: ExecutorDeps,
  task: TaskRow,
  text: string,
  extraParts: unknown[] = [],
): Promise<{ conversationNotified: boolean; ownerNotified: boolean }> {
  // Every caller of this is an event the owner has to resolve — a permanent
  // failure, a budget stall, a blocked goal — so the chat gets the marker that
  // renders it as a waiting-on-you card instead of another assistant reply.
  const conversationNotified = await postConversationNotice(
    deps.db,
    task,
    text,
    noticeParts('needs-attention', extraParts),
  );
  let ownerNotified = false;
  if (deps.notifyOwner) {
    ownerNotified = await deps
      .notifyOwner({ taskId: task.id, conversationId: task.conversationId, text })
      .then(() => true)
      .catch((err) => {
        console.error('owner notification failed', err);
        return false;
      });
  }
  return { conversationNotified, ownerNotified };
}

/**
 * Notify the owner that a task needs them (needs_attention / waiting_event) and,
 * only if at least one leg actually reached somewhere the owner can see, stamp
 * the task so the re-notify sweep leaves it alone. If every leg fails (e.g. a
 * conversation-less task with owner push unconfigured), the row stays unstamped
 * and the sweep keeps retrying until Phase-2's sink or a working channel lands.
 */
export async function notifyAttention(
  deps: ExecutorDeps,
  task: TaskRow,
  text: string,
  extraParts: unknown[] = [],
): Promise<void> {
  const { conversationNotified, ownerNotified } = await notifyOwnerAndConversation(
    deps,
    task,
    text,
    extraParts,
  );
  if (conversationNotified || ownerNotified) {
    await markAttentionNotified(deps.db, task.id).catch((err) =>
      console.error('attention stamp failed', err),
    );
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
