import type { GoalRuntimeRepository } from '@assistant/persistence';
import { and, desc, eq, gt, notInArray, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { goals, messages, tasks } from './schema.js';

const TERMINAL_TASK_STATUSES = ['done', 'failed', 'cancelled'];
/** Task types where the owner is present in the exchange. */
const ATTENDED_GOAL_TASK_TYPES = ['chat_turn', 'sms_turn'];

export function createPostgresGoalRuntimeRepository(db: Db): GoalRuntimeRepository {
  const get = async (agentId: string, goalId: string) => {
    const [goal] = await db
      .select()
      .from(goals)
      .where(and(eq(goals.id, goalId), eq(goals.agentId, agentId)))
      .limit(1);
    return goal ?? null;
  };
  return {
    kind: 'goal-runtime-repository',
    get,
    async recordBlocked(input) {
      await db
        .update(goals)
        .set({ nextAction: input.nextAction, updatedAt: sql`now()` })
        .where(and(eq(goals.id, input.goalId), eq(goals.agentId, input.agentId)));
    },
    async sessionState(agentId, goalId) {
      const [goal, openTasks, recentSessions] = await Promise.all([
        get(agentId, goalId),
        db
          .select({
            id: tasks.id,
            type: tasks.type,
            status: tasks.status,
            updatedAt: tasks.updatedAt,
          })
          .from(tasks)
          .where(
            and(
              eq(tasks.agentId, agentId),
              eq(tasks.goalId, goalId),
              notInArray(tasks.status, TERMINAL_TASK_STATUSES),
            ),
          ),
        db
          .select({ status: tasks.status, progress: tasks.progress, createdAt: tasks.createdAt })
          .from(tasks)
          .where(
            and(
              eq(tasks.agentId, agentId),
              eq(tasks.goalId, goalId),
              notInArray(tasks.type, ATTENDED_GOAL_TASK_TYPES),
            ),
          )
          .orderBy(desc(tasks.createdAt))
          .limit(3),
      ]);
      return { goal, openTasks, recentSessions };
    },
    async ownerRepliedSince(input) {
      const [row] = await db
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, input.conversationId),
            eq(messages.origin, 'owner'),
            gt(messages.createdAt, input.since),
          ),
        )
        .limit(1);
      return Boolean(row);
    },
  };
}
