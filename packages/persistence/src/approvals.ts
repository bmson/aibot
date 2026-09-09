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
}
