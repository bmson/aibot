import type {
  ApprovalRepository,
  ApprovalResolution,
  ApprovalWake,
  ResolveApprovalInput,
} from '@assistant/persistence';
import { approvalIsResolved, approvalSweepBatch, parkedApprovalIds } from '@assistant/persistence';
import { and, asc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { approvalPolicies, approvals, maintenanceCursors, tasks, toolCalls } from './schema.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateApprovalTime(now: Date): void {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
    throw new Error('Invalid approval time');
}

export async function resolveApproval(
  db: Db,
  input: ResolveApprovalInput,
): Promise<ApprovalResolution> {
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
  return {
    ok: true,
    taskId: resolved.taskId,
    toolCallId: resolved.toolCallId,
    approvalId: resolved.id,
    ...(woken ? { wake: { taskId: woken.id, generation: woken.queueGeneration } } : {}),
  };
}

/** Expire a bounded page of pending approvals and wake each parked task once. */
export async function expireStaleApprovals(
  db: Db,
  batch = 200,
  now = new Date(),
): Promise<ApprovalWake[]> {
  const limit = approvalSweepBatch(batch);
  validateApprovalTime(now);
  return db.transaction(async (tx) => {
    const due = tx
      .select({ id: approvals.id })
      .from(approvals)
      .where(and(eq(approvals.status, 'pending'), lte(approvals.expiresAt, now)))
      .orderBy(asc(approvals.expiresAt), asc(approvals.id))
      .limit(limit);
    // Repeat eligibility here so a concurrent decision or expiry extension wins
    // cleanly: whichever UPDATE acquires the approval row first determines the
    // terminal outcome, and the loser returns no row for that approval.
    const expired = await tx
      .update(approvals)
      .set({ status: 'expired', resolvedAt: now })
      .where(
        and(
          inArray(approvals.id, due),
          eq(approvals.status, 'pending'),
          lte(approvals.expiresAt, now),
        ),
      )
      .returning({ id: approvals.id, taskId: approvals.taskId, toolCallId: approvals.toolCallId });
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

    const taskIds = [...new Set(expired.map((approval) => approval.taskId))];
    return tx
      .update(tasks)
      .set({
        status: 'pending',
        runAfter: null,
        lockedUntil: null,
        leaseToken: null,
        queueGeneration: sql`${tasks.queueGeneration} + 1`,
        attempt: 0,
        attentionNotifiedAt: null,
        updatedAt: now,
      })
      .where(and(inArray(tasks.id, taskIds), eq(tasks.status, 'waiting_approval')))
      .returning({ taskId: tasks.id, generation: tasks.queueGeneration });
  });
}

/** Wake parked tasks whose complete approval checkpoint has reached a terminal state. */
export async function resumeResolvedApprovals(
  db: Db,
  batch = 200,
  now = new Date(),
): Promise<ApprovalWake[]> {
  const limit = approvalSweepBatch(batch);
  validateApprovalTime(now);
  const candidates = await db.transaction(async (tx) => {
    await tx
      .insert(maintenanceCursors)
      .values({ name: 'approval-recovery', cursor: null })
      .onConflictDoNothing({ target: maintenanceCursors.name });
    const [cursor] = await tx
      .select()
      .from(maintenanceCursors)
      .where(eq(maintenanceCursors.name, 'approval-recovery'))
      .for('update');
    if (!cursor) throw new Error('Missing approval recovery cursor');

    let page = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.status, 'waiting_approval'),
          cursor.cursor ? gt(tasks.id, cursor.cursor) : undefined,
        ),
      )
      .orderBy(asc(tasks.id))
      .limit(limit);
    // A deleted task can leave the durable cursor beyond every remaining ID.
    // Wrap in this same allocation transaction so a cycle still makes
    // progress instead of spending one full invocation on an empty page.
    if (page.length === 0 && cursor.cursor !== null) {
      page = await tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(eq(tasks.status, 'waiting_approval'))
        .orderBy(asc(tasks.id))
        .limit(limit);
    }
    const lastId = page.at(-1)?.id ?? null;
    await tx
      .update(maintenanceCursors)
      .set({ cursor: page.length === limit ? lastId : null, updatedAt: now })
      .where(eq(maintenanceCursors.name, 'approval-recovery'));
    return page;
  });

  const wakes: ApprovalWake[] = [];
  for (const candidate of candidates) {
    const wake = await db.transaction(async (tx) => {
      // ResolveApproval updates approval first and then the task. Do not take
      // approval row locks after this task lock, or the two paths can deadlock.
      const [task] = await tx.select().from(tasks).where(eq(tasks.id, candidate.id)).for('update');
      if (task?.status !== 'waiting_approval') return null;
      const ids = parkedApprovalIds(task.state);
      if (!ids || ids.some((id) => !UUID_PATTERN.test(id))) return null;

      const rows = await tx
        .select({ id: approvals.id, taskId: approvals.taskId, status: approvals.status })
        .from(approvals)
        .where(inArray(approvals.id, ids));
      const byId = new Map(rows.map((row) => [row.id, row]));
      if (
        rows.length !== ids.length ||
        ids.some((id) => {
          const approval = byId.get(id);
          return !approval || approval.taskId !== task.id || !approvalIsResolved(approval.status);
        })
      )
        return null;

      const [updated] = await tx
        .update(tasks)
        .set({
          status: 'pending',
          runAfter: null,
          lockedUntil: null,
          leaseToken: null,
          queueGeneration: sql`${tasks.queueGeneration} + 1`,
          attempt: 0,
          attentionNotifiedAt: null,
          updatedAt: now,
        })
        .where(and(eq(tasks.id, task.id), eq(tasks.status, 'waiting_approval')))
        .returning({ taskId: tasks.id, generation: tasks.queueGeneration });
      return updated ?? null;
    });
    if (wake) wakes.push(wake);
  }
  return wakes;
}

export function createPostgresApprovalRepository(db: Db): ApprovalRepository {
  return {
    kind: 'approval-repository',
    resolve: (input) => resolveApproval(db, input),
    expireStale: (batch, now) => expireStaleApprovals(db, batch, now),
    resumeResolved: (batch, now) => resumeResolvedApprovals(db, batch, now),
  };
}
