import { approvalPolicies, approvals, type Db, toolCalls } from '@assistant/db';
import { and, eq, lte, sql } from 'drizzle-orm';
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

  const [resolved] = await db
    .update(approvals)
    .set({
      status: input.decision,
      resolvedAt: sql`now()`,
      resolvedVia: input.via,
      resolutionPayload: input.editedPayload ?? null,
    })
    .where(matcher)
    .returning();
  if (!resolved) {
    return { ok: false, reason: 'no pending approval matched (already resolved or expired?)' };
  }

  await db
    .update(toolCalls)
    .set({ status: input.decision })
    .where(eq(toolCalls.id, resolved.toolCallId));

  if (input.policy && input.via === 'web') {
    const [policy] = await db
      .insert(approvalPolicies)
      .values({ ...input.policy, createdVia: 'approval_dialog' })
      .returning();
    if (policy) {
      await db
        .update(approvals)
        .set({ createdPolicyId: policy.id })
        .where(eq(approvals.id, resolved.id));
    }
  }

  await wakeTask(db, resolved.taskId);
  return {
    ok: true,
    taskId: resolved.taskId,
    toolCallId: resolved.toolCallId,
    approvalId: resolved.id,
  };
}

/**
 * Sweep: expire stale pending approvals and wake their tasks so the model
 * learns the approval expired (instead of the task dying silently).
 */
export async function expireStaleApprovals(db: Db): Promise<string[]> {
  const expired = await db
    .update(approvals)
    .set({ status: 'expired', resolvedAt: sql`now()` })
    .where(and(eq(approvals.status, 'pending'), lte(approvals.expiresAt, sql`now()`)))
    .returning();

  for (const approval of expired) {
    await db
      .update(toolCalls)
      .set({ status: 'denied', error: 'approval expired' })
      .where(eq(toolCalls.id, approval.toolCallId));
    await wakeTask(db, approval.taskId);
  }
  return expired.map((a) => a.taskId);
}
