import type { MissionRepository } from '@assistant/persistence';
import { and, desc, eq, notInArray, or, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { tasks } from './schema.js';

const TERMINAL_TASK_STATUSES = ['done', 'failed', 'cancelled'];

export function createPostgresMissionRepository(db: Db): MissionRepository {
  return {
    kind: 'mission-repository',
    async activeSession(agentId, missionId) {
      const [session] = await db
        .select({ id: tasks.id, status: tasks.status })
        .from(tasks)
        .where(
          and(
            eq(tasks.agentId, agentId),
            eq(tasks.parentTaskId, missionId),
            notInArray(tasks.status, TERMINAL_TASK_STATUSES),
          ),
        )
        .orderBy(desc(tasks.updatedAt))
        .limit(1);
      return session ?? null;
    },
    async spentUsd(agentId, missionId) {
      const [spend] = await db
        .select({ total: sql<number>`coalesce(sum(${tasks.spentUsd}), 0)` })
        .from(tasks)
        .where(
          and(
            eq(tasks.agentId, agentId),
            or(eq(tasks.id, missionId), eq(tasks.parentTaskId, missionId)),
          ),
        );
      return Number(spend?.total ?? 0);
    },
  };
}
