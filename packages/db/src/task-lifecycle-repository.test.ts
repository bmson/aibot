import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import { createDb } from './client.js';
import { agents, tasks } from './schema.js';
import { createPostgresTaskRepository } from './task-lifecycle-repository.js';

it('does not reclaim a PostgreSQL lease renewed after the expired-task scan', async () => {
  const url = process.env.DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  const db = createDb(url);
  const id = randomUUID();
  try {
    const [agent] = await db.select().from(agents).limit(1);
    if (!agent) throw new Error('Seed the test database');
    await db.insert(tasks).values({
      id,
      agentId: agent.id,
      type: 'adhoc',
      status: 'running',
      lockedUntil: new Date(0),
    });
    const renewedUntil = new Date(Date.now() + 600_000);
    // Deterministically pause between the scan's result and the recovery UPDATE.
    // The UPDATE itself and the following due-task query still execute on PostgreSQL.
    vi.spyOn(db, 'select').mockImplementationOnce(
      () =>
        ({
          from: () => ({
            where: () => ({
              orderBy: () => ({
                limit: async () => {
                  await db.update(tasks).set({ lockedUntil: renewedUntil }).where(eq(tasks.id, id));
                  return [{ id }];
                },
              }),
            }),
          }),
        }) as unknown as ReturnType<typeof db.select>,
    );
    await createPostgresTaskRepository(db).findDueTasks();
    const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
    expect(row).toMatchObject({
      status: 'running',
      reclaimCount: 0,
      queueGeneration: 0,
      lockedUntil: renewedUntil,
    });
  } finally {
    vi.restoreAllMocks();
    await db.delete(tasks).where(eq(tasks.id, id));
    await db.$client.end();
  }
});
