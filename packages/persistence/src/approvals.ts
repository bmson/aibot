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

export type ApprovalResolution = ResolveApprovalResult & {
  wake?: { taskId: string; generation: number };
};
export interface ApprovalRepository {
  readonly kind: 'approval-repository';
  resolve(input: ResolveApprovalInput): Promise<ApprovalResolution>;
  /** Each expired approval, tool denial and eligible task wake commit atomically. */
  expireStale(batch?: number, now?: Date): Promise<ApprovalWake[]>;
  /** Recheck the locked task checkpoint and every referenced approval before waking. */
  resumeResolved(batch?: number, now?: Date): Promise<ApprovalWake[]>;
}

export interface ApprovalWake {
  taskId: string;
  generation: number;
}

/** Bound both the sweep query and each parked task's approval reads. */
export function approvalSweepBatch(batch = 200): number {
  if (!Number.isInteger(batch) || batch < 1 || batch > 200)
    throw new Error('Invalid approval sweep batch');
  return batch;
}

/** Malformed or oversized checkpoints must not authorize resuming a task. */
export function parkedApprovalIds(state: unknown): string[] | null {
  const entries = (state as { pendingApprovals?: unknown } | null)?.pendingApprovals;
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 200) return null;
  const ids: string[] = [];
  for (const entry of entries) {
    const id = (entry as { approvalId?: unknown } | null)?.approvalId;
    if (typeof id !== 'string' || id.length === 0 || new TextEncoder().encode(id).length > 1000)
      return null;
    ids.push(id);
  }
  return [...new Set(ids)];
}

export function approvalIsResolved(status: unknown): boolean {
  return status === 'approved' || status === 'denied' || status === 'expired';
}
