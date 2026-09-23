import type { SkillLibraryRepository, SkillMutationRepository } from '@assistant/persistence';

/** Matches the learned-skill item returned by the mobile workspace API. */
export type MobileWorkspaceSkill = {
  id: string;
  name: string;
  preconditions: string;
  steps: string;
  gotchas: string;
  ownerAuthored: boolean;
  deprecated: boolean;
  useCount: number;
  successCount: number;
  failureCount: number;
  updatedAt: string;
};

export async function listMobileWorkspaceSkills(
  repository: SkillLibraryRepository,
  agentId: string,
): Promise<MobileWorkspaceSkill[]> {
  const skills = await repository.list(agentId);
  return skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    preconditions: skill.preconditions,
    steps: skill.steps,
    gotchas: skill.gotchas,
    ownerAuthored: skill.ownerAuthored,
    deprecated: skill.deprecated,
    useCount: skill.useCount,
    successCount: skill.successCount,
    failureCount: skill.failureCount,
    updatedAt: skill.updatedAt.toISOString(),
  }));
}

export function setMobileSkillDeprecated(
  repository: SkillMutationRepository,
  agentId: string,
  skillId: string,
  deprecated: boolean,
): Promise<void> {
  return repository.setDeprecated(agentId, skillId, deprecated);
}

export function deleteMobileSkill(
  repository: SkillMutationRepository,
  agentId: string,
  skillId: string,
): Promise<void> {
  return repository.delete(agentId, skillId);
}
