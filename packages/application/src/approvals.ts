import { getAgent } from '@assistant/core/chat';
import {
  type ApprovalInbox,
  type ApprovalRepository,
  listApprovalInbox as listApprovalInboxWorkflow,
  type ResolveApprovalResult,
  resolveApproval,
} from '@assistant/core/workflow/approvals';
import { createPostgresApprovalRepository, type Db } from '@assistant/db';

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

export type {
  ApprovalInbox,
  PendingApprovalItem,
  ResolvedApprovalItem,
} from '@assistant/core/workflow/approvals';

export interface ApprovalInboxStore {
  agentId: string;
  approvals: ApprovalRepository;
}

export interface ApprovalRememberStore {
  agentId: string;
  approvals: ApprovalRepository;
}

/**
 * Load the complete approvals screen projection. Keeping this query here means
 * the UI knows the use case and view shape, not tables, joins, or SQL rules.
 */
export async function listApprovalInbox(
  store: Db | ApprovalInboxStore,
  recentLimit = 20,
  now = new Date(),
): Promise<ApprovalInbox> {
  if ('approvals' in store) {
    return listApprovalInboxWorkflow(store.approvals, store.agentId, {
      recentLimit,
      now,
    });
  }
  const agent = await getAgent(store);
  return listApprovalInboxWorkflow(store, agent.id, {
    recentLimit,
    now,
  });
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
  if (!Array.isArray(to) || to.length !== 1 || typeof to[0] !== 'string') return null;
  const recipient = to[0].trim().toLowerCase();
  if (!recipient) return null;
  return {
    agentId,
    toolName: 'gmail.send',
    templateKey: 'gmail.send.to_recipient',
    match: { recipient },
    effect: 'allow',
  };
}

/** Approve once, optionally remembering the one safe recipient-scoped rule. */
export async function approveAndRememberApproval(
  store: Db | ApprovalRememberStore,
  approvalId: string,
): Promise<ResolveApprovalResult> {
  const portable = 'approvals' in store && 'agentId' in store;
  const repository = portable ? store.approvals : createPostgresApprovalRepository(store as Db);
  const agentId = portable ? store.agentId : (await getAgent(store as Db)).id;
  const row = await repository.getRememberable(agentId, approvalId);
  if (!row) {
    return { ok: false, reason: 'no pending approval matched (already resolved or expired?)' };
  }

  const policy = rememberedApprovalPolicy(agentId, row.toolName, row.approval.payload);
  return resolveApproval(repository, {
    approvalId,
    decision: 'approved',
    via: 'web',
    ...(policy ? { policy } : {}),
  });
}
