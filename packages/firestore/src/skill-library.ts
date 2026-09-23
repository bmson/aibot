import type { SkillLibraryRepository, WorkspaceSkillRecord } from '@assistant/persistence';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const MAX_WORKSPACE_SKILLS = 500;
const FIELDS = [
  'id',
  'agentId',
  'name',
  'preconditions',
  'steps',
  'gotchas',
  'ownerAuthored',
  'deprecated',
  'useCount',
  'successCount',
  'failureCount',
  'updatedAt',
] as const;

function skillFromDocument(
  value: unknown,
  documentId: string,
  agentId: string,
): WorkspaceSkillRecord {
  const row = decodeRecord<Record<string, unknown>>(value);
  if (
    row.agentId !== agentId ||
    typeof row.id !== 'string' ||
    documentKey(row.id) !== documentId ||
    typeof row.name !== 'string' ||
    typeof row.preconditions !== 'string' ||
    typeof row.steps !== 'string' ||
    typeof row.gotchas !== 'string' ||
    typeof row.ownerAuthored !== 'boolean' ||
    typeof row.deprecated !== 'boolean' ||
    !(row.updatedAt instanceof Date) ||
    !Number.isFinite(row.updatedAt.getTime()) ||
    ![row.useCount, row.successCount, row.failureCount].every(
      (count) => Number.isSafeInteger(count) && Number(count) >= 0,
    )
  )
    throw new Error('Invalid learned-skill document');

  return {
    id: row.id,
    name: row.name,
    preconditions: row.preconditions,
    steps: row.steps,
    gotchas: row.gotchas,
    ownerAuthored: row.ownerAuthored,
    deprecated: row.deprecated,
    useCount: row.useCount as number,
    successCount: row.successCount as number,
    failureCount: row.failureCount as number,
    updatedAt: row.updatedAt,
  };
}

/** Lists one owner's complete mobile skill library without loading vector data. */
export class FirestoreSkillLibraryRepository implements SkillLibraryRepository {
  readonly kind = 'skill-library-repository' as const;

  constructor(readonly store: InstallationStore) {}

  async list(agentId: string): Promise<WorkspaceSkillRecord[]> {
    if (!agentId) throw new Error('An agent is required to list learned skills');
    const snapshot = await this.store
      .collection('skills')
      .where('agentId', '==', agentId)
      .select(...FIELDS)
      .limit(MAX_WORKSPACE_SKILLS + 1)
      .get();
    if (snapshot.size > MAX_WORKSPACE_SKILLS)
      throw new Error('Learned-skill library exceeds the mobile workspace limit');

    return snapshot.docs
      .map((doc) => skillFromDocument(doc.data(), doc.id, agentId))
      .sort(
        (left, right) =>
          Number(right.ownerAuthored) - Number(left.ownerAuthored) ||
          Number(left.deprecated) - Number(right.deprecated) ||
          right.updatedAt.getTime() - left.updatedAt.getTime() ||
          left.id.localeCompare(right.id),
      );
  }
}
