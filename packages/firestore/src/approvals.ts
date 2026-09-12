import { createHash, randomUUID } from 'node:crypto';
import {
  type ApprovalRepository,
  type ApprovalResolution,
  type ApprovalWake,
  approvalIsResolved,
  approvalSweepBatch,
  parkedApprovalIds,
  type Records,
  type ResolveApprovalInput,
} from '@assistant/persistence';
import { createWakeIntent } from './outbox.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

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

  async expireStale(batch = 200, suppliedNow?: Date): Promise<ApprovalWake[]> {
    const limit = approvalSweepBatch(batch);
    const now = suppliedNow ?? this.store.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
      throw new Error('Invalid approval sweep time');
    const due = await this.store
      .collection('approvals')
      .where('status', '==', 'pending')
      .where('expiresAt', '<=', now)
      .orderBy('expiresAt', 'asc')
      .orderBy('id', 'asc')
      .limit(limit)
      .get();
    const wakes: ApprovalWake[] = [];
    for (const candidate of due.docs) {
      const wake = await this.store.db.runTransaction(async (tx) => {
        const approvalRef = candidate.ref;
        const snapshot = await tx.get(approvalRef);
        if (!snapshot.exists || snapshot.get('status') !== 'pending') return null;
        const approval = decodeRecord<Records['approvals']>(snapshot.data());
        if (!(approval.expiresAt instanceof Date) || approval.expiresAt > now) return null;
        const taskRef = this.store.doc('tasks', approval.taskId);
        const toolRef = this.store.doc('toolCalls', approval.toolCallId);
        const [task, tool] = await tx.getAll(taskRef, toolRef);
        if (
          !task?.exists ||
          !tool?.exists ||
          task.get('id') !== approval.taskId ||
          tool.get('taskId') !== approval.taskId
        )
          throw new Error('Approval references missing or mismatched task/tool records');

        const generation = Number(task.get('queueGeneration')) + 1;
        if (!Number.isSafeInteger(generation) || generation < 1)
          throw new Error('Invalid task queue generation');
        tx.update(approvalRef, encodeRecord({ status: 'expired', resolvedAt: now }));
        tx.update(toolRef, { status: 'denied', error: 'approval expired' });

        if (task.get('status') !== 'waiting_approval') return null;
        tx.update(taskRef, {
          status: 'pending',
          runAfter: null,
          lockedUntil: null,
          leaseToken: null,
          queueGeneration: generation,
          attempt: 0,
          attentionNotifiedAt: null,
          updatedAt: now,
        });
        createWakeIntent(tx, this.store, {
          taskId: approval.taskId,
          generation,
          availableAt: now,
        });
        return { taskId: approval.taskId, generation };
      });
      if (wake) wakes.push(wake);
    }
    return wakes;
  }

  async resumeResolved(batch = 200, suppliedNow?: Date): Promise<ApprovalWake[]> {
    const limit = approvalSweepBatch(batch);
    const now = suppliedNow ?? this.store.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
      throw new Error('Invalid approval sweep time');
    const cursorRef = this.store.doc('coordination', 'approval-recovery-cursor');
    const parked = await this.store.db.runTransaction(async (tx) => {
      const cursorSnapshot = await tx.get(cursorRef);
      const cursor = cursorSnapshot.exists ? cursorSnapshot.get('cursor') : null;
      if (cursor !== null && typeof cursor !== 'string')
        throw new Error('Invalid approval recovery cursor');
      const baseQuery = this.store
        .collection('tasks')
        .where('status', '==', 'waiting_approval')
        .orderBy('id', 'asc');
      const query = cursor ? baseQuery.startAfter(cursor) : baseQuery;
      let page = await tx.get(query.limit(limit));
      if (page.empty && cursor !== null) page = await tx.get(baseQuery.limit(limit));
      const lastId = page.docs.at(-1)?.get('id');
      if (page.size === limit && typeof lastId !== 'string')
        throw new Error('Invalid approval recovery task ID');
      tx.set(cursorRef, {
        cursor: page.size === limit ? lastId : null,
        updatedAt: now,
      });
      return page.docs.map((candidate) => candidate.ref);
    });
    const wakes: ApprovalWake[] = [];
    for (const taskRef of parked) {
      const wake = await this.store.db.runTransaction(async (tx) => {
        const snapshot = await tx.get(taskRef);
        if (!snapshot.exists || snapshot.get('status') !== 'waiting_approval') return null;
        const task = decodeRecord<Records['tasks']>(snapshot.data());
        if (typeof task.id !== 'string') return null;
        try {
          if (documentKey(task.id) !== taskRef.id) return null;
        } catch {
          return null;
        }
        const ids = parkedApprovalIds(task.state);
        if (!ids) return null;
        const approvalSnapshots = await tx.getAll(
          ...ids.map((id) => this.store.doc('approvals', id)),
        );
        for (const approval of approvalSnapshots) {
          if (
            !approval.exists ||
            approval.get('taskId') !== task.id ||
            !approvalIsResolved(approval.get('status'))
          )
            return null;
        }
        const generation = Number(task.queueGeneration) + 1;
        if (!Number.isSafeInteger(generation) || generation < 1) return null;
        tx.update(taskRef, {
          status: 'pending',
          runAfter: null,
          lockedUntil: null,
          leaseToken: null,
          queueGeneration: generation,
          attempt: 0,
          attentionNotifiedAt: null,
          updatedAt: now,
        });
        createWakeIntent(tx, this.store, {
          taskId: task.id,
          generation,
          availableAt: now,
        });
        return { taskId: task.id, generation };
      });
      if (wake) wakes.push(wake);
    }
    return wakes;
  }
}
