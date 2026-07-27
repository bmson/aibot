import { getAgent } from '@assistant/core/chat';
import { type ResolveApprovalResult, resolveApproval } from '@assistant/core/workflow/approvals';
import { approvals, type Db, tasks, toolCalls } from '@assistant/db';
import { and, asc, desc, eq, gt, inArray, lte, or, sql } from 'drizzle-orm';

export type ApprovalDecision = 'approved' | 'denied';

/** Persistence-independent approval data consumed by presentation adapters. */
export interface ApprovalSnapshot {
  id: string;
  taskId: string;
  shortCode: string;
  summary: string;
  payload: unknown;
  resolutionPayload: unknown;
  status: string;
  requestedAt: Date;
  resolvedAt: Date | null;
  resolvedVia: string | null;
  expiresAt: Date;
}

export interface PendingApprovalItem {
  approval: ApprovalSnapshot;
  taskType: string;
  taskTrust: string;
  toolName: string;
  decision: unknown;
}

export interface ResolvedApprovalItem {
  approval: ApprovalSnapshot;
  taskType: string;
}

export interface ApprovalInbox {
  pending: PendingApprovalItem[];
  resolved: ResolvedApprovalItem[];
}

/**
 * Load the complete approvals screen projection. Keeping this query here means
 * the UI knows the use case and view shape, not tables, joins, or SQL rules.
 */
export async function listApprovalInbox(db: Db, recentLimit = 20): Promise<ApprovalInbox> {
  const { id: agentId } = await getAgent(db);
  const [pending, resolved] = await Promise.all([
    db
      .select({
        approval: approvals,
        taskType: tasks.type,
        taskTrust: tasks.trust,
        toolName: toolCalls.toolName,
        decision: toolCalls.decision,
      })
      .from(approvals)
      .innerJoin(tasks, eq(approvals.taskId, tasks.id))
      .innerJoin(toolCalls, eq(approvals.toolCallId, toolCalls.id))
      .where(
        and(
          eq(tasks.agentId, agentId),
          eq(approvals.status, 'pending'),
          gt(approvals.expiresAt, sql`now()`),
        ),
      )
      .orderBy(asc(approvals.requestedAt)),
    db
      .select({ approval: approvals, taskType: tasks.type })
      .from(approvals)
      .innerJoin(tasks, eq(approvals.taskId, tasks.id))
      .where(
        and(
          eq(tasks.agentId, agentId),
          or(
            inArray(approvals.status, ['approved', 'denied', 'expired']),
            and(eq(approvals.status, 'pending'), lte(approvals.expiresAt, sql`now()`)),
          ),
        ),
      )
      .orderBy(desc(approvals.resolvedAt))
      .limit(recentLimit),
  ]);

  return { pending, resolved };
}

/** Resolve one owner decision through the durable approval workflow. */
export function decideApproval(
  db: Db,
  approvalId: string,
  decision: ApprovalDecision,
  editedPayload?: Record<string, unknown>,
): Promise<ResolveApprovalResult> {
  return resolveApproval(db, {
    approvalId,
    decision,
    via: 'web',
    ...(editedPayload ? { editedPayload } : {}),
  });
}

/** Resolve a bounded group while preserving a failure result for every item. */
export async function decideApprovals(
  db: Db,
  approvalIds: readonly string[],
  decision: ApprovalDecision,
): Promise<Array<{ approvalId: string; error: string }>> {
  const failures: Array<{ approvalId: string; error: string }> = [];
  for (const approvalId of approvalIds.slice(0, 20)) {
    const result = await decideApproval(db, approvalId, decision);
    if (!result.ok) failures.push({ approvalId, error: result.reason });
  }
  return failures;
}

export interface RememberedApprovalPolicy {
  agentId: string;
  toolName: 'gmail.send';
  templateKey: 'gmail.send.to_recipient';
  match: { recipient: string };
  effect: 'allow';
}

/**
 * Derive the deliberately narrow standing rule supported by the approvals UI.
 * Ambiguous/multiple recipients never produce a reusable policy.
 */
export function rememberedApprovalPolicy(
  agentId: string,
  toolName: string,
  payload: unknown,
): RememberedApprovalPolicy | null {
  if (toolName !== 'gmail.send' || !payload || typeof payload !== 'object') return null;
  const to = (payload as { to?: unknown }).to;
  const recipients = Array.isArray(to)
    ? to.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : [];
  const [recipient] = recipients;
  if (recipients.length !== 1 || !recipient) return null;
  return {
    agentId,
    toolName: 'gmail.send',
    templateKey: 'gmail.send.to_recipient',
    match: { recipient: recipient.toLowerCase() },
    effect: 'allow',
  };
}

/** Approve once, optionally remembering the one safe recipient-scoped rule. */
export async function approveAndRememberApproval(
  db: Db,
  approvalId: string,
): Promise<ResolveApprovalResult> {
  const [row] = await db
    .select({ approval: approvals, toolName: toolCalls.toolName })
    .from(approvals)
    .innerJoin(toolCalls, eq(approvals.toolCallId, toolCalls.id))
    .where(eq(approvals.id, approvalId))
    .limit(1);
  if (row?.approval.status !== 'pending') {
    return { ok: false, reason: 'no pending approval matched (already resolved or expired?)' };
  }

  const agent = await getAgent(db);
  const policy = rememberedApprovalPolicy(agent.id, row.toolName, row.approval.payload);
  return resolveApproval(db, {
    approvalId,
    decision: 'approved',
    via: 'web',
    ...(policy ? { policy } : {}),
  });
}
