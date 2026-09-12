import {
  approvals,
  createPostgresApprovalRepository,
  type Db,
  type TaskRow,
  tasks,
  toolCalls,
} from '@assistant/db';
import type {
  ApprovalRepository,
  ResolveApprovalInput,
  ResolveApprovalResult,
} from '@assistant/persistence';
import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import { persistMessage } from '../chat.js';
import { getQueueNotifier } from '../queue.js';

export type { ResolveApprovalInput, ResolveApprovalResult } from '@assistant/persistence';

/**
 * Resolve a pending approval. Idempotent: the status-guarded UPDATE means a
 * double-tap (or a YES both in web and SMS) resolves exactly once.
 */
export async function resolveApproval(
  store: Db | ApprovalRepository,
  input: ResolveApprovalInput,
): Promise<ResolveApprovalResult> {
  const repository =
    'kind' in store && store.kind === 'approval-repository'
      ? (store as ApprovalRepository)
      : createPostgresApprovalRepository(store as Db);
  const { wake, ...result } = await repository.resolve(input);
  if (wake && !input.deferNotification) getQueueNotifier().notify(wake.taskId, wake.generation);
  return result;
}

/**
 * Which delivery legs of a park notice actually landed. Only a leg that
 * succeeded may be stamped: renotifyStalledApprovals() repairs whatever is
 * missing, so recording a conversation write that in fact failed retires the
 * backstop and strands the approval with no card in the chat — invisible to
 * the owner until the 24h expiry, and unrecoverable by a page reload.
 */
export function deliveredChannels(input: {
  ownerNotified: boolean;
  conversationNotified: boolean;
}): string[] {
  return [
    ...(input.ownerNotified ? ['owner'] : []),
    ...(input.conversationNotified ? ['conversation'] : []),
  ];
}

/**
 * Record which park notices for these approvals actually reached the owner. An
 * approval still missing the 'conversation' leg after a grace period was parked
 * by a worker that crashed — or whose conversation write failed — between the
 * park commit and the notices; renotifyStalledApprovals() re-emits those.
 *
 * Callers pass the full set they know landed (see deliveredChannels): this
 * replaces the column rather than appending to it, so a partial stamp must
 * never drop a leg an earlier attempt already delivered.
 */
export async function markApprovalsNotified(
  db: Db,
  approvalIds: string[],
  channels: string[],
): Promise<void> {
  // No leg landed — leave the row untouched so the sweep still selects it.
  if (approvalIds.length === 0 || channels.length === 0) return;
  await db
    .update(approvals)
    .set({ notifiedChannels: channels })
    .where(and(inArray(approvals.id, approvalIds), eq(approvals.status, 'pending')));
}

/**
 * Sweep backstop for a crash between approval park and notify: the task sits
 * in waiting_approval with a pending approval row, but no SMS/email/dashboard
 * notice ever went out — silent until the 24h expiry. Re-emit the notices for
 * any un-notified pending approval older than the grace window, then stamp it.
 * At-least-once safe: a concurrent stamp just makes the next sweep skip it.
 */
export async function renotifyStalledApprovals(
  db: Db,
  notifyApproval?: (
    task: TaskRow,
    notices: Array<{ taskId: string; shortCode: string; summary: string; toolName?: string }>,
  ) => Promise<void>,
  opts: { olderThanMinutes?: number; batch?: number } = {},
): Promise<number> {
  const olderThanMinutes = opts.olderThanMinutes ?? 5;
  const rows = await db
    .select({ approval: approvals, task: tasks, toolName: toolCalls.toolName })
    .from(approvals)
    .innerJoin(tasks, eq(approvals.taskId, tasks.id))
    .innerJoin(toolCalls, eq(approvals.toolCallId, toolCalls.id))
    .where(
      and(
        eq(approvals.status, 'pending'),
        // Missing the conversation leg, not merely un-notified: an approval
        // whose owner ping landed but whose chat card did not is exactly the
        // row this sweep has to repair, and it carries a non-empty array.
        sql`NOT ('conversation' = ANY(${approvals.notifiedChannels}))`,
        lte(approvals.requestedAt, sql`now() - make_interval(mins => ${olderThanMinutes})`),
        eq(tasks.status, 'waiting_approval'),
      ),
    )
    .limit(opts.batch ?? 50);
  if (rows.length === 0) return 0;

  const byTask = new Map<
    string,
    { task: TaskRow; notices: Array<(typeof rows)[number]['approval'] & { toolName: string }> }
  >();
  for (const row of rows) {
    const entry = byTask.get(row.task.id) ?? { task: row.task, notices: [] };
    entry.notices.push({ ...row.approval, toolName: row.toolName });
    byTask.set(row.task.id, entry);
  }

  let renotified = 0;
  for (const { task, notices } of byTask.values()) {
    try {
      // Repair only the legs actually missing. A row reaches this sweep having
      // already texted the owner whenever the conversation write was the half
      // that failed — re-sending would bill and buzz them twice for one
      // approval, so the owner ping is skipped once it is stamped.
      const ownerAlreadyNotified = notices.every((approval) =>
        approval.notifiedChannels.includes('owner'),
      );
      let ownerNotified = ownerAlreadyNotified;
      if (notifyApproval && !ownerAlreadyNotified) {
        await notifyApproval(
          task,
          notices.map((approval) => ({
            taskId: task.id,
            shortCode: approval.shortCode,
            summary: approval.summary,
            toolName: approval.toolName,
          })),
        );
        ownerNotified = true;
      }
      if (task.conversationId) {
        const text = [
          'This needs your approval before I act:',
          ...notices.map((approval) => `- **[${approval.shortCode}]** ${approval.summary}`),
          "Approve or deny it on the Approvals page — I'll pick up from there.",
        ].join('\n');
        await persistMessage(db, {
          conversationId: task.conversationId,
          taskId: task.id,
          role: 'assistant',
          origin: 'assistant',
          // The approval cards render themselves; the prose lives only in the
          // `text` column for model history (see carriesOwnCard in notices.ts).
          parts: notices.map((approval) => ({
            type: 'approval',
            approvalId: approval.id,
            shortCode: approval.shortCode,
            summary: approval.summary,
          })),
          text,
        });
      }
      // Reaching here means every leg attempted above succeeded — a throw from
      // either one skips the stamp and leaves the row for the next sweep. A
      // task with no conversation owes no card, so its conversation leg counts
      // as settled rather than re-selecting the row on every future sweep.
      await markApprovalsNotified(
        db,
        notices.map((approval) => approval.id),
        deliveredChannels({ ownerNotified, conversationNotified: true }),
      );
      renotified += notices.length;
    } catch (err) {
      // Leave the rows unstamped — the next sweep retries this task's notices.
      console.error('approval re-notification failed', { taskId: task.id }, err);
    }
  }
  return renotified;
}

/**
 * Backstop for the pre-park race: an approval resolved in the narrow window
 * between its row being created and the task transitioning to waiting_approval
 * fires a wake that finds the task still 'running' and no-ops, stranding it in
 * waiting_approval forever. Resume any waiting_approval task whose parked
 * approvals are ALL resolved (nothing still pending) — so a task genuinely
 * waiting on a human is never woken early, but a stranded one recovers on the
 * next bounded scan cycle. Each repository rechecks and atomically wakes the task.
 */
export async function resumeResolvedApprovalTasks(
  store: Db | ApprovalRepository,
  batch = 200,
  now?: Date,
): Promise<string[]> {
  const portable = 'kind' in store && store.kind === 'approval-repository';
  const repository = portable
    ? (store as ApprovalRepository)
    : createPostgresApprovalRepository(store as Db);
  const wakes = await repository.resumeResolved(batch, now);
  if (!portable) for (const wake of wakes) getQueueNotifier().notify(wake.taskId, wake.generation);
  return wakes.map((wake) => wake.taskId);
}

/**
 * Sweep: expire stale pending approvals and wake their tasks so the model
 * learns the approval expired (instead of the task dying silently).
 */
export async function expireStaleApprovals(
  store: Db | ApprovalRepository,
  batch = 200,
  now?: Date,
): Promise<string[]> {
  const portable = 'kind' in store && store.kind === 'approval-repository';
  const repository = portable
    ? (store as ApprovalRepository)
    : createPostgresApprovalRepository(store as Db);
  const wakes = await repository.expireStale(batch, now);
  if (!portable) for (const wake of wakes) getQueueNotifier().notify(wake.taskId, wake.generation);
  return wakes.map((wake) => wake.taskId);
}
