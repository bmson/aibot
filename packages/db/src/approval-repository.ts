import type {
  ApprovalRepository,
  ApprovalResolution,
  ResolveApprovalInput,
} from '@assistant/persistence';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { approvalPolicies, approvals, tasks, toolCalls } from './schema.js';

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

export function createPostgresApprovalRepository(db: Db): ApprovalRepository {
  return { kind: 'approval-repository', resolve: (input) => resolveApproval(db, input) };
}
