import type {
  WorkspaceImprovementRecord,
  WorkspaceImprovementRepository,
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
