import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
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

it('persists plans only for the current owner lease', async () => {
  const url = process.env.DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  const db = createDb(url);
  const id = randomUUID();
  try {
    const [agent] = await db.select().from(agents).limit(1);
    if (!agent) throw new Error('Seed the test database');
    await db.insert(tasks).values({ id, agentId: agent.id, type: 'adhoc' });
    const repo = createPostgresTaskRepository(db);
    const first = await repo.claim(id);
    if (!first) throw new Error('Missing initial lease');

    // Reclaim the task so the first worker's token is stale.
    await db
      .update(tasks)
      .set({ lockedUntil: new Date(0) })
      .where(eq(tasks.id, id));
    const replacement = await repo.claim(id);
    if (!replacement) throw new Error('Missing replacement lease');

    expect(await repo.persistPlan(first, { stale: true })).toBe(false);
    expect(
      await repo.persistPlan({ ...replacement, agentId: randomUUID() }, { foreign: true }),
    ).toBe(false);
    expect(await repo.persistPlan(replacement, { steps: ['current'] })).toBe(true);
    expect((await db.select().from(tasks).where(eq(tasks.id, id)))[0]?.plan).toEqual({
      steps: ['current'],
    });
  } finally {
    await db.delete(tasks).where(eq(tasks.id, id));
    await db.$client.end();
  }
});

it('creates at most five owned scheduled children atomically and preserves taint', async () => {
  const url = process.env.DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  const db = createDb(url);
  const parentId = randomUUID();
  const childIds: string[] = [];
  try {
    const [agent] = await db.select().from(agents).limit(1);
    if (!agent) throw new Error('Seed the test database');
    await db.insert(tasks).values({
      id: parentId,
      agentId: agent.id,
      type: 'chat_turn',
      trust: 'owner',
      status: 'pending',
    });
    const repo = createPostgresTaskRepository(db);
    const runAfter = new Date(Date.now() + 60_000);
    const results = await Promise.allSettled(
      Array.from({ length: 7 }, (_, index) =>
        repo.createScheduledFollowUp({
          parentTaskId: parentId,
          agentId: agent.id,
          instruction: `follow-up ${index}`,
          runAfter,
          trust: 'assistant',
          tainted: true,
        }),
      ),
    );
    const created = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value.task] : [],
    );
    childIds.push(...created.map((task) => task.id));
    expect(created).toHaveLength(5);
    expect(created.every((task) => task.parentTaskId === parentId)).toBe(true);
    expect(created.every((task) => task.agentId === agent.id)).toBe(true);
    expect(created.every((task) => task.trust === 'assistant')).toBe(true);
    expect(created.every((task) => task.status === 'sleeping')).toBe(true);
    expect(created.every((task) => task.runAfter?.getTime() === runAfter.getTime())).toBe(true);
    const due = await repo.findDueTasks(200);
    expect(due.some((task) => childIds.includes(task.id))).toBe(false);
    expect(
      created.every(
        (task) =>
          (task.trigger as { payload?: { taintedOrigin?: unknown } }).payload?.taintedOrigin ===
          true,
      ),
    ).toBe(true);
    await expect(
      repo.createScheduledFollowUp({
        parentTaskId: parentId,
        agentId: randomUUID(),
        instruction: 'foreign parent',
        runAfter,
        trust: 'owner',
        tainted: false,
      }),
    ).rejects.toThrow('another agent');
    await expect(
      repo.createScheduledFollowUp({
        parentTaskId: parentId,
        agentId: agent.id,
        instruction: 'past wake',
        runAfter: new Date(0),
        trust: 'owner',
        tainted: false,
      }),
    ).rejects.toThrow('future');
  } finally {
    if (childIds.length) await db.delete(tasks).where(inArray(tasks.id, childIds));
    await db.delete(tasks).where(eq(tasks.id, parentId));
    await db.$client.end();
  }
});
