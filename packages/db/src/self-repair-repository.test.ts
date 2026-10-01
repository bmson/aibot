import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { createDb } from './client.js';
import { agents, selfRepairIssues } from './schema.js';
import { createPostgresSelfRepairRepository } from './self-repair-repository.js';

it('deduplicates reports, atomically claims one repair and rejects stale writes', async () => {
  const url = process.env.DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  const db = createDb(url);
  const id = randomUUID();
  try {
    await db.insert(agents).values({
      id,
      name: 'Repair test',
      email: `${id}@example.test`,
      calendarId: 'primary',
      workspacePrefix: `repair-test-${id}`,
    });
    const repository = createPostgresSelfRepairRepository(db);
    const input = {
      fingerprint: 'same',
      source: 'feedback' as const,
      title: 'A synthetic failure',
      summary: 'Reproduce it',
    };
    const [a, b] = await Promise.all([repository.report(id, input), repository.report(id, input)]);
    expect(a.id).toBe(b.id);
    const newer = await repository.report(id, { ...input, fingerprint: 'another' });
    const blocked = await repository.update(a, 'blocked', {}, new Date());
    if (!blocked) throw new Error('Fixture update failed');
    await repository.update(blocked, 'reported', {}, new Date(Date.now() + 1000));
    const now = new Date();
    const claimed = await Promise.all([repository.claim(id, now, 2), repository.claim(id, now, 2)]);
    expect(claimed.filter(Boolean)).toHaveLength(1);
    const row = claimed.find(Boolean)!;
    expect(row.id).toBe(newer.id);
    const dispatched = await repository.update(
      row,
      'fixing',
      { dispatchedAt: now.toISOString() },
      now,
    );
    expect(dispatched).not.toBeNull();
    expect(await repository.update(row, 'failed', {}, now)).toBeNull();
    await repository.update(dispatched!, 'failed', {}, now);
    expect(await repository.claim(id, now, 1)).toBeNull();
    const queued = (await repository.list(id)).find((item) => item.status === 'reported');
    if (!queued) throw new Error('Missing queued issue');
    await repository.update(queued, 'reported', { manualRunRequestedAt: now.toISOString() }, now);
    const manual = await repository.claim(id, now, 0);
    expect(manual?.id).toBe(queued.id);
    expect(manual?.data.manualRunRequestedAt).toBeUndefined();
    expect(manual?.data.manualRunStartedAt).toBe(now.toISOString());
    expect(await repository.claim(id, now, 0)).toBeNull();
    await expect(
      repository.report(id, { ...input, fingerprint: 'foreign', sourceTaskId: randomUUID() }),
    ).rejects.toThrow('outside the owner');
  } finally {
    await db.delete(selfRepairIssues).where(eq(selfRepairIssues.agentId, id));
    await db.delete(agents).where(eq(agents.id, id));
    await db.$client.end();
  }
});
