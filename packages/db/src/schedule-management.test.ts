import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { createDb } from './client.js';
import { createPostgresScheduleRepository } from './schedule-repository.js';
import { agents, schedules } from './schema.js';

const DATABASE_URL = process.env.DATABASE_URL;

function testDatabaseUrl(): string {
  if (!DATABASE_URL || !new URL(DATABASE_URL).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  return DATABASE_URL;
}

async function fixture() {
  const db = createDb(testDatabaseUrl());
  const ownerId = randomUUID();
  const otherId = randomUUID();
  for (const [id, label] of [
    [ownerId, 'owner'],
    [otherId, 'other'],
  ] as const) {
    await db.insert(agents).values({
      id,
      name: `schedule-page-${label}-${id.slice(0, 8)}`,
      email: `${id}@schedule-page.invalid`,
      workspacePrefix: `schedule-page/${id}`,
    });
  }
  const scheduleIds: string[] = [];
  return {
    db,
    ownerId,
    otherId,
    repository: createPostgresScheduleRepository(db),
    async schedule(agentId: string, id = randomUUID(), enabled = true) {
      await db.insert(schedules).values({
        id,
        agentId,
        name: `schedule-page:${id}`,
        cron: '* * * * *',
        taskTemplate: { reminderText: 'page test' },
        enabled,
        nextRunAt: null,
      });
      scheduleIds.push(id);
      return id;
    },
    async dispose() {
      if (scheduleIds.length) await db.delete(schedules).where(inArray(schedules.id, scheduleIds));
      await db.delete(agents).where(eq(agents.id, ownerId));
      await db.delete(agents).where(eq(agents.id, otherId));
      await db.$client.end();
    },
  };
}

it('pages all owner schedules in stable ID order, including disabled rows', async () => {
  const f = await fixture();
  try {
    const first = await f.schedule(f.ownerId, '00000000-0000-4000-8000-000000001001', true);
    const second = await f.schedule(f.ownerId, '00000000-0000-4000-8000-000000001002', false);
    const third = await f.schedule(f.ownerId, '00000000-0000-4000-8000-000000001003', true);
    const other = await f.schedule(f.otherId, '00000000-0000-4000-8000-000000001004', true);

    const pageOne = await f.repository.listPage(f.ownerId, { limit: 2 });
    expect(pageOne.items.map((row) => row.id)).toEqual([first, second]);
    expect(pageOne.items.map((row) => row.enabled)).toEqual([true, false]);
    expect(pageOne.nextCursor).toBe(second);

    const pageTwo = await f.repository.listPage(f.ownerId, {
      afterId: pageOne.nextCursor ?? undefined,
      limit: 2,
    });
    expect(pageTwo.items.map((row) => row.id)).toEqual([third]);
    expect(pageTwo.nextCursor).toBeNull();
    expect(pageTwo.items.map((row) => row.id)).not.toContain(other);
  } finally {
    await f.dispose();
  }
});

it('returns empty pages and rejects invalid cursors or limits before SQL', async () => {
  const f = await fixture();
  try {
    expect(await f.repository.listPage(f.ownerId)).toEqual({ items: [], nextCursor: null });
    await expect(f.repository.listPage(f.ownerId, { limit: 0 })).rejects.toThrow('batch');
    await expect(f.repository.listPage(f.ownerId, { limit: 201 })).rejects.toThrow('batch');
    await expect(f.repository.listPage(f.ownerId, { afterId: 'not-a-uuid' })).rejects.toThrow(
      'cursor',
    );
  } finally {
    await f.dispose();
  }
});

it('continues after a deleted cursor without sharing another owner page', async () => {
  const f = await fixture();
  try {
    const first = await f.schedule(f.ownerId, '00000000-0000-4000-8000-000000002001');
    const second = await f.schedule(f.ownerId, '00000000-0000-4000-8000-000000002002');
    await f.schedule(f.otherId, '00000000-0000-4000-8000-000000002003');

    const firstPage = await f.repository.listPage(f.ownerId, { limit: 1 });
    expect(firstPage.items.map((row) => row.id)).toEqual([first]);
    await f.db.delete(schedules).where(eq(schedules.id, first));
    const afterDeleted = await f.repository.listPage(f.ownerId, {
      afterId: first,
      limit: 1,
    });
    expect(afterDeleted.items.map((row) => row.id)).toEqual([second]);
    expect(afterDeleted.nextCursor).toBe(second);
  } finally {
    await f.dispose();
  }
});
