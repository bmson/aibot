import type { Records } from './records.js';

/** The bounded learned-skill fields needed by the mobile workspace. */
export type WorkspaceSkillRecord = Pick<
  Records['skills'],
  | 'id'
  | 'name'
  | 'preconditions'
  | 'steps'
  | 'gotchas'
  | 'ownerAuthored'
  | 'deprecated'
  | 'useCount'
  | 'successCount'
  | 'failureCount'
  | 'updatedAt'
>;

export interface SkillLibraryRepository {
  readonly kind: 'skill-library-repository';
  list(agentId: string): Promise<WorkspaceSkillRecord[]>;
}
