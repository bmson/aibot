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
