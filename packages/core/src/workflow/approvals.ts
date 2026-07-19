import { approvalPolicies, approvals, type Db, tasks, toolCalls } from '@assistant/db';
import { and, eq, inArray, lte, sql } from 'drizzle-orm';
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
