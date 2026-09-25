import type { Records } from './records.js';

type Task = Records['tasks'];

/** Mission reads that the wake loop needs beyond the task lifecycle. */
export interface MissionRepository {
  readonly kind: 'mission-repository';
  /** The most recently updated session child that has not finished, if any. */
  activeSession(agentId: string, missionId: string): Promise<Pick<Task, 'id' | 'status'> | null>;
  /** Model spend charged to the mission and all of its session children, in USD. */
  spentUsd(agentId: string, missionId: string): Promise<number>;
}

export interface MissionSessionProgressInput {
  agentId: string;
  /** The session task calling mission.update; its parent must be a mission. */
  sessionTaskId: string;
  progress: string;
  nextAction: string;
  /** Omitted or null keeps the mission's current percentage. */
  progressPercent?: number | null;
  /** Empty keeps the mission's current scratchpad. */
  notes: string;
}

/** The mission.update tool: a session writes its progress to its parent mission. */
export interface MissionProgressRepository {
  recordSessionProgress(input: MissionSessionProgressInput): Promise<{ updated: string }>;
}
