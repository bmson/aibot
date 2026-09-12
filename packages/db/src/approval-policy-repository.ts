import type { ApprovalPolicyRepository, Records } from '@assistant/persistence';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { approvalPolicies } from './schema.js';

export async function listApprovalPolicies(
  db: Db,
  agentId: string,
  options: { toolName?: string; enabledOnly?: boolean } = {},
): Promise<Records['approvalPolicies'][]> {
  return db
    .select()
    .from(approvalPolicies)
    .where(
      and(
        eq(approvalPolicies.agentId, agentId),
        options.toolName === undefined
          ? undefined
          : eq(approvalPolicies.toolName, options.toolName),
        options.enabledOnly === true ? eq(approvalPolicies.enabled, true) : undefined,
      ),
    )
    .orderBy(asc(approvalPolicies.toolName), asc(approvalPolicies.id));
}

export async function setApprovalPolicyEnabled(
  db: Db,
  agentId: string,
  policyId: string,
  enabled: boolean,
): Promise<boolean> {
  const [updated] = await db
    .update(approvalPolicies)
    .set({ enabled, updatedAt: sql`now()` })
    .where(and(eq(approvalPolicies.agentId, agentId), eq(approvalPolicies.id, policyId)))
    .returning({ id: approvalPolicies.id });
  return Boolean(updated);
}

export async function deleteApprovalPolicy(
  db: Db,
  agentId: string,
  policyId: string,
): Promise<boolean> {
  const [deleted] = await db
    .delete(approvalPolicies)
    .where(and(eq(approvalPolicies.agentId, agentId), eq(approvalPolicies.id, policyId)))
    .returning({ id: approvalPolicies.id });
  return Boolean(deleted);
}

export function createPostgresApprovalPolicyRepository(db: Db): ApprovalPolicyRepository {
  return {
    kind: 'approval-policy-repository',
    list: (agentId, options) => listApprovalPolicies(db, agentId, options),
    setEnabled: (agentId, policyId, enabled) =>
      setApprovalPolicyEnabled(db, agentId, policyId, enabled),
    delete: (agentId, policyId) => deleteApprovalPolicy(db, agentId, policyId),
  };
}
