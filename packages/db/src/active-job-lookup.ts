import type { ActiveJobLookup } from '@assistant/persistence';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { tasks } from './schema.js';

/** The newest unfinished task whose trigger names `job`, as organize-now has always read it. */
export function createPostgresActiveJobLookup(db: Db): ActiveJobLookup {
  return {
    kind: 'active-job-lookup',
    async findActive(agentId, job) {
      const [row] = await db
        .select({ id: tasks.id, status: tasks.status })
        .from(tasks)
        .where(
          and(
            eq(tasks.agentId, agentId),
            inArray(tasks.status, ['pending', 'running']),
            sql`${tasks.trigger} #>> '{payload,job}' = ${job}`,
          ),
        )
        .orderBy(desc(tasks.createdAt))
        .limit(1);
      return row ? { id: row.id, status: row.status as 'pending' | 'running' } : null;
    },
  };
}
