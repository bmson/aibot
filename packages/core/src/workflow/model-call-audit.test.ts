import { createDb, type Db, modelCallAudit, modelCalls } from '@assistant/db';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../chat.js';
import { purgeStaleModelCallAudit } from './maintenance.js';

/**
 * Retention is the reason capture is defensible at all: these rows hold the
 * owner's mail in the clear, so "it expires" has to be true rather than
 * intended. That makes the purge worth an integration test against real
 * Postgres — the interval arithmetic and the batched delete-by-subquery are
 * exactly the things a unit test with a fake would not catch.
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

let db: Db;
let dbUp = false;
const auditIds: string[] = [];
const callIds: string[] = [];

async function insertAudit(ageDays: number): Promise<string> {
  const [row] = await db
    .insert(modelCallAudit)
    .values({
      role: 'draft',
      model: 'test/model',
      method: 'generate',
      capture: 'redacted',
      systemPrompt: 'system',
      input: 'what is on today',
      output: 'Two things.',
      createdAt: sql`now() - make_interval(days => ${ageDays})`,
    })
    .returning({ id: modelCallAudit.id });
  const id = row?.id as string;
  auditIds.push(id);
  return id;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    await getAgent(db);
    dbUp = true;
  } catch {
    console.warn('model-call-audit.test: database unreachable or unseeded — skipping');
  }
});

afterAll(async () => {
  if (dbUp) {
    if (auditIds.length > 0) {
      await db.delete(modelCallAudit).where(inArray(modelCallAudit.id, auditIds));
    }
    if (callIds.length > 0) await db.delete(modelCalls).where(inArray(modelCalls.id, callIds));
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('model_call_audit', () => {
  it('stores a captured call', async () => {
    if (!dbUp) return;
    const id = await insertAudit(0);
    const [row] = await db.select().from(modelCallAudit).where(eq(modelCallAudit.id, id));
    expect(row?.output).toBe('Two things.');
    expect(row?.capture).toBe('redacted');
    expect(row?.truncated).toBe(false);
  });

  it('refuses a capture mode that is not one of the two real ones', async () => {
    if (!dbUp) return;
    // 'off' means no row at all; a row claiming it would misdescribe its own
    // contents to anyone reading the table back.
    await expect(
      db.insert(modelCallAudit).values({
        role: 'draft',
        model: 'test/model',
        method: 'generate',
        capture: 'off',
      }),
    ).rejects.toThrow();
  });

  it('cascades when its cost-ledger row is purged', async () => {
    if (!dbUp) return;
    // Aged-history cleanup deletes model_calls; the captured text must not
    // outlive the call it belongs to.
    const [call] = await db
      .insert(modelCalls)
      .values({ role: 'draft', model: 'test/model' })
      .returning({ id: modelCalls.id });
    const callId = call?.id as string;
    const [row] = await db
      .insert(modelCallAudit)
      .values({
        modelCallId: callId,
        role: 'draft',
        model: 'test/model',
        method: 'generate',
        capture: 'full',
      })
      .returning({ id: modelCallAudit.id });
    const auditId = row?.id as string;

    await db.delete(modelCalls).where(eq(modelCalls.id, callId));
    const remaining = await db.select().from(modelCallAudit).where(eq(modelCallAudit.id, auditId));
    expect(remaining).toHaveLength(0);
  });

  it('purges past the retention window and keeps what is inside it', async () => {
    if (!dbUp) return;
    const stale = await insertAudit(30);
    const fresh = await insertAudit(1);

    const deleted = await purgeStaleModelCallAudit(db, 14);
    expect(deleted).toBeGreaterThanOrEqual(1);

    const staleRows = await db.select().from(modelCallAudit).where(eq(modelCallAudit.id, stale));
    const freshRows = await db.select().from(modelCallAudit).where(eq(modelCallAudit.id, fresh));
    expect(staleRows).toHaveLength(0);
    expect(freshRows).toHaveLength(1);
  });

  it('honours the batch bound so one sweep cannot take a long lock', async () => {
    if (!dbUp) return;
    await insertAudit(40);
    await insertAudit(40);
    expect(await purgeStaleModelCallAudit(db, 14, 1)).toBe(1);
  });

  it('treats a nonsensical retention window as the safe default', async () => {
    if (!dbUp) return;
    // Guards a misconfigured LLM_AUDIT_RETENTION_DAYS from deleting everything.
    const recent = await insertAudit(2);
    await purgeStaleModelCallAudit(db, Number.NaN);
    const rows = await db.select().from(modelCallAudit).where(eq(modelCallAudit.id, recent));
    expect(rows).toHaveLength(1);
  });
});
