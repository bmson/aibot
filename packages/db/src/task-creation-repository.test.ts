import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import { agents, tasks } from './schema.js';
import { createPostgresTaskRepository } from './task-lifecycle-repository.js';

it('task creation inside a larger PostgreSQL transaction rolls back with its caller', async () => {
  const url = process.env.DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith('_test'))
    throw new Error('Requires isolated test database');
  const db = createDb(url);
  const externalEventId = randomUUID();
  try {
    const [agent] = await db.select().from(agents).limit(1);
    if (!agent) throw new Error('Seed the test database');
    await expect(
      db.transaction(async (tx) => {
        await createPostgresTaskRepository(tx as unknown as Db).createTask({
          agentId: agent.id,
          type: 'adhoc',
          trust: 'owner',
          trigger: {},
          externalEventId,
        });
        throw new Error('outer transaction failed');
      }),
    ).rejects.toThrow('outer transaction failed');
    expect(await db.select().from(tasks).where(eq(tasks.externalEventId, externalEventId))).toEqual(
      [],
    );
  } finally {
    await db.$client.end();
  }
});
