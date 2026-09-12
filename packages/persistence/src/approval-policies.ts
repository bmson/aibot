import type { Records } from './records.js';

export interface ApprovalPolicyRepository {
  readonly kind: 'approval-policy-repository';
  /** Owner-scoped, deterministic listing. Tool matching includes enabled rules only. */
  list(
    agentId: string,
    options?: { toolName?: string; enabledOnly?: boolean },
  ): Promise<Records['approvalPolicies'][]>;
  setEnabled(agentId: string, policyId: string, enabled: boolean): Promise<boolean>;
  /** Delete the rule while preserving historical policy IDs on approvals/anomalies. */
  delete(agentId: string, policyId: string): Promise<boolean>;
}
