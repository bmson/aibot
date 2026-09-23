/** Owner-scoped, vector-preserving mutations of an existing learned skill. */
export interface SkillMutationRepository {
  readonly kind: 'skill-mutation-repository';
  setDeprecated(agentId: string, skillId: string, deprecated: boolean): Promise<void>;
  delete(agentId: string, skillId: string): Promise<void>;
}
