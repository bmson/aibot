import { createHash, randomUUID } from 'node:crypto';
import type {
  ApprovalRepository,
  ApprovalResolution,
  Records,
  ResolveApprovalInput,
} from '@assistant/persistence';
import { createWakeIntent } from './outbox.js';
import { decodeRecord, encodeRecord, type InstallationStore } from './store.js';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, v]) => [key, canonical(v)]),
    );
  return value;
}
function policyId(policy: NonNullable<ResolveApprovalInput['policy']>) {
  return createHash('sha256')
    .update(JSON.stringify(canonical(policy)))
    .digest('hex');
}

export class FirestoreApprovalRepository implements ApprovalRepository {
  readonly kind = 'approval-repository' as const;
  constructor(readonly store: InstallationStore) {}

  async resolve(input: ResolveApprovalInput): Promise<ApprovalResolution> {
    if (!input.approvalId && !input.shortCode)
      return { ok: false, reason: 'approvalId or shortCode required' };
    const newPolicyId = randomUUID();
    return this.store.db.runTransaction(async (tx) => {
      const snapshot = input.approvalId
        ? await tx.get(this.store.doc('approvals', input.approvalId))
        : null;
      const matches = !input.approvalId
        ? await tx.get(
            this.store
              .collection('approvals')
              .where('shortCode', '==', input.shortCode)
              .where('status', '==', 'pending')
              .limit(2),
          )
        : null;
      if (matches && matches.size > 1)
        return { ok: false, reason: 'ambiguous approval code; use the approval ID' };
      const selected = snapshot ?? matches?.docs[0];
      if (!selected?.exists || selected.get('status') !== 'pending')
        return { ok: false, reason: 'no pending approval matched (already resolved or expired?)' };
      const approval = decodeRecord<Records['approvals']>(selected.data());
      const taskRef = this.store.doc('tasks', approval.taskId);
      const toolRef = this.store.doc('toolCalls', approval.toolCallId);
      const [task, tool] = await tx.getAll(taskRef, toolRef);
      if (!task?.exists || !tool?.exists || tool.get('taskId') !== approval.taskId) {
        throw new Error('Approval references missing or mismatched task/tool records');
      }
      const now = this.store.now();
      const requestedPolicy = input.via === 'web' ? input.policy : undefined;
      if (
        requestedPolicy &&
        (requestedPolicy.agentId !== task.get('agentId') ||
          requestedPolicy.toolName !== tool.get('toolName'))
      ) {
        throw new Error('Approval policy must match the task owner and tool');
      }
      const policyKey = requestedPolicy
        ? this.store.doc('approvalPolicyKeys', policyId(requestedPolicy))
        : null;
      const keySnapshot = policyKey ? await tx.get(policyKey) : null;
      const resolvedPolicyId = keySnapshot?.exists
        ? String(keySnapshot.get('policyId'))
        : newPolicyId;
      const policyRef = requestedPolicy
        ? this.store.doc('approvalPolicies', resolvedPolicyId)
        : null;
      const existingPolicy = policyRef ? await tx.get(policyRef) : null;
      tx.update(
        selected.ref,
        encodeRecord({
          status: input.decision,
          resolvedAt: now,
          resolvedVia: input.via,
          resolutionPayload: input.editedPayload ?? null,
          ...(policyRef && requestedPolicy ? { createdPolicyId: resolvedPolicyId } : {}),
        }),
      );
      tx.update(toolRef, { status: input.decision });
      if (policyRef && requestedPolicy) {
        if (policyKey && !keySnapshot?.exists) tx.create(policyKey, { policyId: resolvedPolicyId });
        if (existingPolicy?.exists) tx.update(policyRef, { enabled: true, updatedAt: now });
        else
          tx.create(
            policyRef,
            encodeRecord({
              ...requestedPolicy,
              id: resolvedPolicyId,
              enabled: true,
              createdVia: 'approval_dialog',
              version: 1,
              createdAt: now,
              updatedAt: now,
            }),
          );
      }
      const wake = task.get('status') === 'waiting_approval';
      const generation = Number(task.get('queueGeneration')) + 1;
      if (wake) {
        tx.update(taskRef, {
          status: 'pending',
          runAfter: null,
          lockedUntil: null,
          leaseToken: null,
          queueGeneration: generation,
          attempt: 0,
          updatedAt: now,
        });
        // Always retain the repair intent, including callers that defer immediate notification.
        createWakeIntent(tx, this.store, { taskId: approval.taskId, generation, availableAt: now });
      }
      return {
        ok: true,
        taskId: approval.taskId,
        toolCallId: approval.toolCallId,
        approvalId: approval.id,
        ...(wake ? { wake: { taskId: approval.taskId, generation } } : {}),
      };
    });
  }
}
