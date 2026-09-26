/** A finished task the nightly reflection may distil into a skill. */
export interface ReflectionTask {
  id: string;
  agentId: string;
  trust: string;
  trigger: unknown;
  state: unknown;
  plan: unknown;
  progress: string | null;
}

/** One recorded step of a reflected task, in step order. */
export interface ReflectionToolCall {
  toolName: string;
  status: string;
  error: string | null;
  args: unknown;
}

/** A skill drafted by reflection, before it is embedded. */
export interface ReflectedSkill {
  name: string;
  preconditions: string;
  steps: string;
  gotchas: string;
  sourceTaskId: string;
  originTrust: 'owner' | 'assistant';
}

/** The `skill.reflect` job's reads and its one write. Drafting stays in core. */
export interface SkillReflectionRepository {
  readonly kind: 'skill-reflection-repository';
  /** Done owner- or assistant-trust tasks created since `since`, newest first. */
  candidates(since: Date, limit: number): Promise<ReflectionTask[]>;
  /** The subset of `taskIds` that already taught a skill. */
  sourcedTaskIds(taskIds: string[]): Promise<string[]>;
  toolCalls(taskId: string): Promise<ReflectionToolCall[]>;
  /** Whether a same-named skill was written by the owner, which reflection never overwrites. */
  ownerAuthored(agentId: string, name: string): Promise<boolean>;
  /**
   * Insert the skill, or revise the same-named one and revive it. Returns true
   * only for a new skill; an owner-authored skill is left untouched.
   */
  saveReflected(agentId: string, skill: ReflectedSkill, embedding: number[]): Promise<boolean>;
}
