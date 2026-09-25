import {
  MODEL_ROLE_NAMES,
  type WorkspaceImprovementRecord,
  type WorkspaceImprovementRepository,
} from '@assistant/persistence';
import { assertPrivacyErasureFenceUnchanged, readPrivacyErasureFence } from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const MAX_OWNER_PROPOSALS = 2_000;
const MOBILE_RESULT_LIMIT = 100;
const FIELDS = [
  'id',
  'agentId',
  'status',
  'kind',
  'title',
  'rationale',
  'change',
  'evidenceIds',
  'createdAt',
] as const;

function fromDocument(
  value: unknown,
  documentId: string,
  agentId: string,
): WorkspaceImprovementRecord | null {
  const row = decodeRecord<Record<string, unknown>>(value);
  if (
    row.agentId !== agentId ||
    typeof row.id !== 'string' ||
    documentKey(row.id) !== documentId ||
    !['open', 'applied', 'dismissed'].includes(String(row.status))
  )
    throw new Error('Invalid owner improvement document');
  if (row.status !== 'open') return null;
  if (
    !['model_role', 'policy', 'prompt', 'note'].includes(String(row.kind)) ||
    typeof row.title !== 'string' ||
    typeof row.rationale !== 'string' ||
    !row.change ||
    typeof row.change !== 'object' ||
    Array.isArray(row.change) ||
    !Array.isArray(row.evidenceIds) ||
    !row.evidenceIds.every((id) => typeof id === 'string') ||
    !(row.createdAt instanceof Date) ||
    !Number.isFinite(row.createdAt.getTime())
  )
    throw new Error('Invalid open improvement document');
  return {
    id: row.id,
    kind: row.kind as WorkspaceImprovementRecord['kind'],
    title: row.title,
    rationale: row.rationale,
    change: row.change as Record<string, unknown>,
    evidenceIds: row.evidenceIds,
    createdAt: row.createdAt,
  };
}

/** One owner-indexed scan avoids a composite index and never silently cuts off older rows. */
export class FirestoreWorkspaceImprovementRepository implements WorkspaceImprovementRepository {
  readonly kind = 'workspace-improvement-repository' as const;

  constructor(readonly store: InstallationStore) {}

  /**
   * Apply or dismiss one owner proposal with the same effects as the
   * PostgreSQL workflow: advisory proposals are acknowledged, and an
   * evidence-backed `model_role` proposal swaps the role to enabled models in
   * the same transaction that marks it applied.
   */
  async applyAction(
    configuredAgentId: string,
    proposalId: string,
    action: 'apply' | 'dismiss',
  ): Promise<void> {
    if (!configuredAgentId) throw new Error('agent is required');
    const proposalRef = this.store.doc('improvementProposals', proposalId);
    const ownerRef = this.store.doc('agents', configuredAgentId);
    const erasureRef = this.store.doc('privacyErasureJobs', configuredAgentId);

    await this.store.db.runTransaction(async (tx) => {
      const owners = await tx.get(this.store.collection('agents').limit(2));
      if (
        owners.size !== 1 ||
        owners.docs[0]?.get('id') !== configuredAgentId ||
        owners.docs[0]?.id !== ownerRef.id
      )
        throw new Error('Improvement action requires exactly one configured owner');

      const [proposal, erasure] = await tx.getAll(proposalRef, erasureRef);
      if (erasure?.exists) {
        if (erasure.get('agentId') !== configuredAgentId || erasure.get('status') !== 'complete')
          throw new Error('Privacy erasure is in progress');
      }
      if (!proposal?.exists) throw new Error('Improvement proposal not found');
      const row = decodeRecord<Record<string, unknown>>(proposal.data());
      if (
        row.agentId !== configuredAgentId ||
        row.id !== proposalId ||
        proposal.id !== documentKey(proposalId)
      )
        throw new Error('Improvement proposal belongs to another agent');
      if (!['open', 'applied', 'dismissed'].includes(String(row.status)))
        throw new Error('Invalid improvement proposal status');

      if (action === 'dismiss') {
        if (row.status !== 'dismissed')
          tx.update(proposalRef, { status: 'dismissed', updatedAt: this.store.now() });
        return;
      }

      // SQL applyProposal treats repeated/non-open approvals as a no-op.
      if (row.status !== 'open') return;
      if (!['model_role', 'policy', 'prompt', 'note'].includes(String(row.kind)))
        throw new Error('Invalid improvement proposal kind');
      if (
        typeof row.title !== 'string' ||
        typeof row.rationale !== 'string' ||
        !row.change ||
        typeof row.change !== 'object' ||
        Array.isArray(row.change) ||
        !Array.isArray(row.evidenceIds) ||
        !row.evidenceIds.every((value) => typeof value === 'string')
      )
        throw new Error('Invalid improvement proposal');
      if (row.kind === 'model_role') {
        // A routing swap must cite the pattern it claims to fix; without
        // evidence it stays open, exactly as the PostgreSQL workflow leaves it.
        if (row.evidenceIds.length === 0) return;
        const swap = await this.modelRoleSwap(tx, row.change as Record<string, unknown>);
        if (swap) tx.update(swap.ref, { ...swap.patch, updatedAt: this.store.now() });
      }
      // Policy, prompt, and note proposals are advisory in the SQL workflow;
      // approval only acknowledges the proposal and changes its status.
      tx.update(proposalRef, { status: 'applied', updatedAt: this.store.now() });
    });
  }

  /**
   * Resolve a proposed routing change to the enabled models it names. Unknown
   * or disabled models and unknown roles are recorded only, as in PostgreSQL.
   */
  private async modelRoleSwap(
    tx: FirebaseFirestore.Transaction,
    change: Record<string, unknown>,
  ): Promise<{
    ref: FirebaseFirestore.DocumentReference;
    patch: { primaryModel?: string; fallbackModel?: string };
  } | null> {
    const role = typeof change.role === 'string' ? change.role : '';
    const primaryModel = typeof change.primaryModel === 'string' ? change.primaryModel : '';
    const fallbackModel = typeof change.fallbackModel === 'string' ? change.fallbackModel : '';
    if (!(MODEL_ROLE_NAMES as readonly string[]).includes(role)) return null;
    const wanted = [...new Set([primaryModel, fallbackModel].filter(Boolean))];
    if (!wanted.length) return null;
    const roleRef = this.store.doc('modelRoles', role);
    const [roleSnapshot, ...models] = await tx.getAll(
      roleRef,
      ...wanted.map((id) => this.store.doc('models', id)),
    );
    const enabled = new Set(
      models
        .filter(
          (model) =>
            model?.exists &&
            model.get('enabled') === true &&
            typeof model.get('id') === 'string' &&
            documentKey(model.get('id')) === model.id,
        )
        .map((model) => model?.get('id') as string),
    );
    const patch: { primaryModel?: string; fallbackModel?: string } = {};
    if (primaryModel && enabled.has(primaryModel)) patch.primaryModel = primaryModel;
    if (fallbackModel && enabled.has(fallbackModel)) patch.fallbackModel = fallbackModel;
    if (!patch.primaryModel && !patch.fallbackModel) return null;
    // PostgreSQL updates by role and silently matches nothing for a missing row.
    if (!roleSnapshot?.exists) return null;
    if (roleSnapshot.get('role') !== role) throw new Error('Model role identity mismatch');
    return { ref: roleRef, patch };
  }

  async listOpen(agentId: string): Promise<WorkspaceImprovementRecord[]> {
    if (!agentId) throw new Error('agent is required');
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const snapshot = await this.store
      .collection('improvementProposals')
      .where('agentId', '==', agentId)
      .select(...FIELDS)
      .limit(MAX_OWNER_PROPOSALS + 1)
      .get();
    if (snapshot.size > MAX_OWNER_PROPOSALS)
      throw new Error('Owner improvements exceed the mobile workspace scan limit');
    const result = snapshot.docs
      .map((doc) => fromDocument(doc.data(), doc.id, agentId))
      .filter((row): row is WorkspaceImprovementRecord => row !== null)
      .sort(
        (left, right) =>
          right.createdAt.getTime() - left.createdAt.getTime() || left.id.localeCompare(right.id),
      )
      .slice(0, MOBILE_RESULT_LIMIT);
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return result;
  }
}
