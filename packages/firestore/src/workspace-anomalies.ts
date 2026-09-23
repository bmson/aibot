import type { WorkspaceAnomalyRecord, WorkspaceAnomalyRepository } from '@assistant/persistence';
import { assertPrivacyErasureFenceUnchanged, readPrivacyErasureFence } from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const MAX_OWNER_ANOMALIES = 2_000;
const MOBILE_RESULT_LIMIT = 100;
const FIELDS = [
  'id',
  'agentId',
  'status',
  'kind',
  'toolName',
  'detail',
  'observed',
  'expected',
  'toolCallIds',
  'policyId',
  'createdAt',
] as const;

function fromDocument(
  value: unknown,
  documentId: string,
  agentId: string,
): WorkspaceAnomalyRecord | null {
  const row = decodeRecord<Record<string, unknown>>(value);
  if (
    row.agentId !== agentId ||
    typeof row.id !== 'string' ||
    documentKey(row.id) !== documentId ||
    !['open', 'dismissed', 'suspended'].includes(String(row.status))
  )
    throw new Error('Invalid owner anomaly document');
  if (row.status !== 'open') return null;
  if (
    !['frequency', 'off_hours', 'burst'].includes(String(row.kind)) ||
    typeof row.toolName !== 'string' ||
    typeof row.detail !== 'string' ||
    !Number.isSafeInteger(row.observed) ||
    Number(row.observed) < 0 ||
    !Number.isSafeInteger(row.expected) ||
    Number(row.expected) < 0 ||
    !Array.isArray(row.toolCallIds) ||
    !row.toolCallIds.every((id) => typeof id === 'string') ||
    !(row.policyId === null || typeof row.policyId === 'string') ||
    !(row.createdAt instanceof Date) ||
    !Number.isFinite(row.createdAt.getTime())
  )
    throw new Error('Invalid open anomaly document');
  return {
    id: row.id,
    kind: row.kind as WorkspaceAnomalyRecord['kind'],
    toolName: row.toolName,
    detail: row.detail,
    observed: row.observed as number,
    expected: row.expected as number,
    toolCallIds: row.toolCallIds,
    policyId: row.policyId,
    createdAt: row.createdAt,
  };
}

/** One owner-indexed scan avoids a composite index and never silently cuts off older rows. */
export class FirestoreWorkspaceAnomalyRepository implements WorkspaceAnomalyRepository {
  readonly kind = 'workspace-anomaly-repository' as const;

  constructor(readonly store: InstallationStore) {}

  async listOpen(agentId: string): Promise<WorkspaceAnomalyRecord[]> {
    if (!agentId) throw new Error('agent is required');
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const snapshot = await this.store
      .collection('anomalies')
      .where('agentId', '==', agentId)
      .select(...FIELDS)
      .limit(MAX_OWNER_ANOMALIES + 1)
      .get();
    if (snapshot.size > MAX_OWNER_ANOMALIES)
      throw new Error('Owner anomalies exceed the mobile workspace scan limit');
    const result = snapshot.docs
      .map((doc) => fromDocument(doc.data(), doc.id, agentId))
      .filter((row): row is WorkspaceAnomalyRecord => row !== null)
      .sort(
        (left, right) =>
          right.createdAt.getTime() - left.createdAt.getTime() || left.id.localeCompare(right.id),
      )
      .slice(0, MOBILE_RESULT_LIMIT);
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return result;
  }
}
