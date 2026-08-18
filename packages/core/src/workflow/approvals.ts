import {
  approvalPolicies,
  approvals,
  type Db,
  type TaskRow,
  tasks,
  toolCalls,
} from '@assistant/db';
import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import { persistMessage } from '../chat.js';
import { getQueueNotifier } from '../queue.js';
import { wakeTask } from './machine.js';

export interface ResolveApprovalInput {
  approvalId?: string;
  /** SMS path: "YES A7" → shortCode A7. Only matches pending approvals. */
  shortCode?: string;
  decision: 'approved' | 'denied';
  via: 'web' | 'sms';
  /** Edit-then-approve: these args are used at execution instead of the original payload. */
  editedPayload?: Record<string, unknown>;
  /**
   * Always/Never: create a policy from the tool's constrained template.
   * Built by the caller (which has the registry); web-only — never offered via SMS.
   */
  policy?: {
    agentId: string;
    toolName: string;
    templateKey: string;
    match: Record<string, unknown>;
    effect: 'allow' | 'deny';
  };
  /** Caller will resume the task itself (used by bounded internal canaries/tests). */
  deferNotification?: boolean;
}

export type ResolveApprovalResult =
  | { ok: true; taskId: string; toolCallId: string; approvalId: string }
  | { ok: false; reason: string };

/**
 * Resolve a pending approval. Idempotent: the status-guarded UPDATE means a
 * double-tap (or a YES both in web and SMS) resolves exactly once.
 */
export async function resolveApproval(
  db: Db,
  input: ResolveApprovalInput,
): Promise<ResolveApprovalResult> {
  if (!input.approvalId && !input.shortCode) {
    return { ok: false, reason: 'approvalId or shortCode required' };
  }

  const matcher = input.approvalId
    ? and(eq(approvals.id, input.approvalId), eq(approvals.status, 'pending'))
    : and(eq(approvals.shortCode, input.shortCode as string), eq(approvals.status, 'pending'));

  const resolution = await db.transaction(async (tx) => {
    const [resolved] = await tx
      .update(approvals)
      .set({
        status: input.decision,
        resolvedAt: sql`now()`,
        resolvedVia: input.via,
        resolutionPayload: input.editedPayload ?? null,
      })
      .where(matcher)
      .returning();
    if (!resolved) return null;

    await tx
      .update(toolCalls)
      .set({ status: input.decision })
      .where(eq(toolCalls.id, resolved.toolCallId));

    if (input.policy && input.via === 'web') {
      const [policy] = await tx
        .insert(approvalPolicies)
        .values({ ...input.policy, createdVia: 'approval_dialog' })
        .onConflictDoUpdate({
          target: [
            approvalPolicies.agentId,
            approvalPolicies.toolName,
            approvalPolicies.templateKey,
            approvalPolicies.match,
            approvalPolicies.effect,
          ],
          // Repeating Always/Never is also an explicit request to reactivate a
          // matching rule that was paused in Settings.
          set: { enabled: true, updatedAt: sql`now()` },
        })
        .returning();
      if (policy) {
        await tx
          .update(approvals)
          .set({ createdPolicyId: policy.id })
          .where(eq(approvals.id, resolved.id));
      }
    }

    // Only the state this approval actually parks may be resumed. A late
    // response must never resurrect a cancelled/completed task.
    const [woken] = await tx
      .update(tasks)
      .set({
        status: 'pending',
        runAfter: null,
        lockedUntil: null,
        queueGeneration: sql`${tasks.queueGeneration} + 1`,
        attempt: 0,
        updatedAt: sql`now()`,
      })
      .where(and(eq(tasks.id, resolved.taskId), eq(tasks.status, 'waiting_approval')))
      .returning({ id: tasks.id, queueGeneration: tasks.queueGeneration });

    return { resolved, woken };
  });

  if (!resolution) {
    return { ok: false, reason: 'no pending approval matched (already resolved or expired?)' };
  }
  const { resolved, woken } = resolution;
  if (woken && !input.deferNotification) {
    getQueueNotifier().notify(resolved.taskId, woken.queueGeneration);
  }
  return {
    ok: true,
    taskId: resolved.taskId,
    toolCallId: resolved.toolCallId,
    approvalId: resolved.id,
  };
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
          parts: [
            { type: 'text', text },
            ...notices.map((approval) => ({
              type: 'approval',
              approvalId: approval.id,
              shortCode: approval.shortCode,
              summary: approval.summary,
            })),
          ],
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
 * next sweep. Idempotent via wakeTask's status-guarded CAS.
 */
export async function resumeResolvedApprovalTasks(db: Db, batch = 200): Promise<string[]> {
  const parked = await db
    .select({ id: tasks.id, state: tasks.state })
    .from(tasks)
    .where(eq(tasks.status, 'waiting_approval'))
    .limit(batch);

  const woken: string[] = [];
  for (const task of parked) {
    const pendingApprovals =
      (task.state as { pendingApprovals?: Array<{ approvalId?: unknown }> } | null)
        ?.pendingApprovals ?? [];
    const ids = pendingApprovals
      .map((entry) => entry.approvalId)
      .filter((id): id is string => typeof id === 'string');
    if (ids.length === 0) continue;
    const rows = await db
      .select({ status: approvals.status })
      .from(approvals)
      .where(inArray(approvals.id, ids));
    // Only resume when every parked approval is decided; a still-pending one
    // means the task is legitimately waiting and must not be churned.
    if (rows.length < ids.length || rows.some((row) => row.status === 'pending')) continue;
    if (await wakeTask(db, task.id)) woken.push(task.id);
  }
  return woken;
}

/**
 * Sweep: expire stale pending approvals and wake their tasks so the model
 * learns the approval expired (instead of the task dying silently).
 */
export async function expireStaleApprovals(db: Db, batch = 200): Promise<string[]> {
  const taskIds = await db.transaction(async (tx) => {
    const due = tx
      .select({ id: approvals.id })
      .from(approvals)
      .where(and(eq(approvals.status, 'pending'), lte(approvals.expiresAt, sql`now()`)))
      .orderBy(approvals.expiresAt)
      .limit(batch);
    const expired = await tx
      .update(approvals)
      .set({ status: 'expired', resolvedAt: sql`now()` })
      .where(and(inArray(approvals.id, due), eq(approvals.status, 'pending')))
      .returning();
    if (expired.length === 0) return [];

    await tx
      .update(toolCalls)
      .set({ status: 'denied', error: 'approval expired' })
      .where(
        inArray(
          toolCalls.id,
          expired.map((approval) => approval.toolCallId),
        ),
      );

    const uniqueTaskIds = [...new Set(expired.map((approval) => approval.taskId))];
    const woken = await tx
      .update(tasks)
      .set({
        status: 'pending',
        runAfter: null,
        lockedUntil: null,
        queueGeneration: sql`${tasks.queueGeneration} + 1`,
        attempt: 0,
        updatedAt: sql`now()`,
      })
      .where(and(inArray(tasks.id, uniqueTaskIds), eq(tasks.status, 'waiting_approval')))
      .returning({ id: tasks.id, queueGeneration: tasks.queueGeneration });
    return woken;
  });

  const notifier = getQueueNotifier();
  for (const task of taskIds) notifier.notify(task.id, task.queueGeneration);
  return taskIds.map((task) => task.id);
}
