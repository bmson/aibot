import type { ApprovalPolicyRepository, Records } from '@assistant/persistence';
import { decodeRecord, encodeRecord, type InstallationStore } from './store.js';

function policyTime(now: Date): Date {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
    throw new Error('Invalid approval policy time');
  return now;
}

export class FirestoreApprovalPolicyRepository implements ApprovalPolicyRepository {
  readonly kind = 'approval-policy-repository' as const;

  constructor(readonly store: InstallationStore) {}

  async list(
    agentId: string,
    options: { toolName?: string; enabledOnly?: boolean } = {},
  ): Promise<Records['approvalPolicies'][]> {
    let query = this.store.collection('approvalPolicies').where('agentId', '==', agentId);
    if (options.toolName !== undefined) query = query.where('toolName', '==', options.toolName);
    if (options.enabledOnly) query = query.where('enabled', '==', true);
    const rows = await query.orderBy('toolName', 'asc').orderBy('id', 'asc').get();
    return rows.docs.map((row) => decodeRecord<Records['approvalPolicies']>(row.data()));
  }

  async setEnabled(agentId: string, policyId: string, enabled: boolean): Promise<boolean> {
    const now = policyTime(this.store.now());
    return this.store.db.runTransaction(async (tx) => {
      const ref = this.store.doc('approvalPolicies', policyId);
      const policy = await tx.get(ref);
      if (!policy.exists || policy.get('agentId') !== agentId) return false;
      tx.update(ref, encodeRecord({ enabled, updatedAt: now }));
      return true;
    });
  }

  async delete(agentId: string, policyId: string): Promise<boolean> {
    return this.store.db.runTransaction(async (tx) => {
      const policyRef = this.store.doc('approvalPolicies', policyId);
      const policy = await tx.get(policyRef);
      if (!policy.exists || policy.get('agentId') !== agentId) return false;
      const mappings = await tx.get(
        this.store.collection('approvalPolicyKeys').where('policyId', '==', policyId),
      );
      tx.delete(policyRef);
      for (const mapping of mappings.docs)
        if (mapping.get('policyId') === policyId) tx.delete(mapping.ref);
      return true;
    });
  }
}
