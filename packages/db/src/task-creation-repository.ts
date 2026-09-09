import { randomUUID } from 'node:crypto';
import {
  existingTaskResult,
  isExternalRoot,
  newTaskRecord,
  type TaskCreateInput,
  type TaskCreateResult,
  TaskRateLimitError,
} from '@assistant/persistence';
import { and, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { rateLimits, tasks } from './schema.js';

/** Also works inside a caller's transaction; queue notification belongs after commit. */
export async function createTask(db: Db, input: TaskCreateInput): Promise<TaskCreateResult> {
  return db.transaction(async (tx) => {
    // A shared lock serializes the count + insert, including when no policy row exists.
    // Owner work and internal children never wait on this external flood backstop.
    if (isExternalRoot(input))
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('assistant:external-task-limit'))`,
      );
    if (input.externalEventId) {
      const [existing] = await tx
        .select()
        .from(tasks)
        .where(eq(tasks.externalEventId, input.externalEventId));
      if (existing) return existingTaskResult(existing, input);
    }
    if (isExternalRoot(input)) {
      const [policy] = await tx.select().from(rateLimits).where(eq(rateLimits.scope, 'task'));
      for (const [cap, hours] of [
        [policy?.maxPerHour, 1],
        [policy?.maxPerDay, 24],
      ] as const) {
        if (cap == null) continue;
        const [count] = await tx
          .select({ n: sql<number>`count(*)` })
          .from(tasks)
          .where(
            and(
              inArray(tasks.trust, ['known', 'unknown']),
              isNull(tasks.parentTaskId),
              gte(tasks.createdAt, sql`clock_timestamp() - ${hours} * interval '1 hour'`),
            ),
          );
        if (Number(count?.n ?? 0) >= cap) throw new TaskRateLimitError();
      }
    }
    const [clock] = await tx.execute<{ now: string }>(sql`select clock_timestamp() as now`);
    if (!clock) throw new Error('Missing database clock');
    const row = newTaskRecord(input, randomUUID(), new Date(clock.now));
    const [task] = await tx
      .insert(tasks)
      .values(row)
      .onConflictDoNothing({
        target: tasks.externalEventId,
        where: sql`${tasks.externalEventId} IS NOT NULL`,
      })
      .returning();
    if (task) return { task, created: true };
    if (input.externalEventId) {
      const [existing] = await tx
        .select()
        .from(tasks)
        .where(eq(tasks.externalEventId, input.externalEventId));
      if (existing) return existingTaskResult(existing, input);
    }
    throw new Error('Task creation conflict without an existing task');
  });
}
