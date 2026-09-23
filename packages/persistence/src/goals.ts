import type { Records } from './records.js';

export interface GoalReadRepository {
  list(agentId: string): Promise<{
    goals: Records['goals'][];
    conversations: Records['conversations'][];
    tasks: Records['tasks'][];
    schedules: Records['schedules'][];
  }>;
  get(agentId: string, id: string): Promise<Records['goals'] | null>;
}

/** The bounded progress write used by a goal work session. Task binding is checked by the dispatcher. */
export interface GoalProgressRepository {
  updateProgress(input: {
    agentId: string;
    goalId: string;
    progress: string;
    nextAction: string;
  }): Promise<{ updated: string; title: string }>;
}
