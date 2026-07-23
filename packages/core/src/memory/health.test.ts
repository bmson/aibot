import { createHash, randomUUID } from 'node:crypto';
import { createDb, type Db, memories } from '@assistant/db';
import { like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../chat.js';
import { getMemoryHealth, type MemoryHealth } from './health.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';
const MARKER = `xtest-memory-health-${randomUUID()}`;

let db: Db;
let dbUp = false;
let agentId = '';
let before: MemoryHealth;
const organizedAt = new Date();

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    agentId = (await getAgent(db)).id;
    before = await getMemoryHealth(db, agentId);
    dbUp = true;
  } catch {
    console.warn('health.test: database unreachable — skipping');
    return;
  }

  const row = (
    suffix: string,
    values: Partial<typeof memories.$inferInsert> = {},
  ): typeof memories.$inferInsert => {
    const content = `${MARKER}:${suffix}`;
    return {
      agentId,
      category: 'knowledge',
      kind: 'fact',
      content,
      contentHash: contentHash(content),
      originTrust: 'owner',
      ...values,
    };
  };

  await db
    .insert(memories)
    .values([
      row('unorganized'),
      row('organized', { lastConsolidatedAt: organizedAt }),
      row('awaiting-review', { quarantined: true }),
      row('confirmed', { ownerConfirmed: true }),
      row('expired', { expiresAt: new Date(Date.now() - 60_000) }),
    ]);
});

afterAll(async () => {
  if (dbUp) await db.delete(memories).where(like(memories.content, `${MARKER}%`));
  await (db as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

describe('memory health', () => {
  it('counts usable, unorganized, review, confirmed, and expired memories correctly', async () => {
    if (!dbUp) return;
    const health = await getMemoryHealth(db, agentId);
    expect(health.totalUsable - before.totalUsable).toBe(3);
    expect(health.notYetOrganized - before.notYetOrganized).toBe(2);
    expect(health.awaitingReview - before.awaitingReview).toBe(1);
    expect(health.ownerConfirmed - before.ownerConfirmed).toBe(1);
    expect(health.lastOrganizedAt?.getTime()).toBeGreaterThanOrEqual(organizedAt.getTime());
  });
});
