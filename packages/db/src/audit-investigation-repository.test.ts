import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { createPostgresAuditInvestigationRepository } from './audit-investigation-repository.js';
import { createDb, type Db } from './client.js';
import { agents, modelCallAudit, tasks } from './schema.js';

it('scopes PostgreSQL audit reads and pages equal millisecond timestamps without dropping records', async () => {
  const url = process.env.DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith('_test'))
    throw new Error('Requires isolated test database');
  const db = createDb(url);
  try {
    const rollback = new Error('rollback');
    await expect(
      db.transaction(async (tx) => {
        const [owner] = await tx.select({ id: agents.id }).from(agents).limit(1);
        if (!owner) throw new Error('Seed test database');
        const taskId = randomUUID();
        await tx
          .insert(tasks)
          .values({ id: taskId, agentId: owner.id, type: 'chat_turn', trigger: { kind: 'chat' } });
        const ids = [randomUUID(), randomUUID(), randomUUID()].sort().reverse();
        const at = new Date('2026-09-30T01:00:00Z');
        for (const id of ids)
          await tx.insert(modelCallAudit).values({
            id,
            taskId,
            role: 'draft',
            model: 'test/provider',
            method: 'generate',
            capture: 'redacted',
            input: 'request',
            output: 'failure',
            createdAt: sql`'2026-09-30T01:00:00.000123Z'::timestamptz`,
          });
        const repo = createPostgresAuditInvestigationRepository(tx as unknown as Db);
        expect(await repo.task(randomUUID(), taskId)).toBeNull();
        expect(
          await repo.read(randomUUID(), taskId, { section: 'modelCallAudit', limit: 2 }),
        ).toEqual([]);
        const first = await repo.read(owner.id, taskId, { section: 'modelCallAudit', limit: 2 });
        const next = await repo.read(owner.id, taskId, {
          section: 'modelCallAudit',
          limit: 2,
          cursor: { at, id: ids[1] as string },
        });
        expect([...first, ...next].map((row) => row.id)).toEqual(ids);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  } finally {
    await db.$client.end();
  }
});
