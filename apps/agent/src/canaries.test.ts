import { createHash } from 'node:crypto';
import { canaryRuns, createDb, type Db } from '@assistant/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CANARY_CHECK_NAMES,
  recordCanaryBrowserResult,
  runBoundedCanaryCheck,
  runCanaryOperationSet,
} from './canaries.js';

describe('canary orchestration', () => {
  it('bounds a check and propagates cancellation to the operation', async () => {
    let aborted = false;
    const result = await runBoundedCanaryCheck(5, async (signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(signal.reason);
          },
          { once: true },
        );
      });
      return 'unreachable';
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('timed out after 5ms');
    expect(aborted).toBe(true);
  });

  it('runs all channel checks concurrently and isolates failures', async () => {
    const started = new Set<string>();
    let release: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operations = Object.fromEntries(
      CANARY_CHECK_NAMES.map((name) => [
        name,
        vi.fn(async () => {
          started.add(name);
          if (started.size === CANARY_CHECK_NAMES.length) release?.();
          await barrier;
          if (name === 'sms') throw new Error('provider rejected test message');
          return `${name} ok`;
        }),
      ]),
    ) as unknown as Parameters<typeof runCanaryOperationSet>[0];

    const checks = await runCanaryOperationSet(operations);

    expect(started).toEqual(new Set(CANARY_CHECK_NAMES));
    expect(checks.sms).toMatchObject({ ok: false, detail: 'provider rejected test message' });
    for (const name of CANARY_CHECK_NAMES.filter((name) => name !== 'sms')) {
      expect(checks[name]).toMatchObject({ ok: true, detail: `${name} ok` });
    }
  });

  it('bounds error details returned by the machine-readable endpoint', async () => {
    const result = await runBoundedCanaryCheck(100, async () => {
      throw new Error(`line one\n${'x'.repeat(1_000)}`);
    });

    expect(result.detail).not.toContain('\n');
    expect(result.detail.length).toBeLessThanOrEqual(300);
  });
});

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';
let db: Db;
let dbUp = false;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    await db.select({ id: canaryRuns.id }).from(canaryRuns).limit(1);
    dbUp = true;
  } catch {
    console.warn('canaries.test: database/schema unavailable — skipping callback integration');
  }
});

afterAll(async () => {
  await (db as unknown as { $client?: { end: () => Promise<void> } }).$client?.end?.();
});

describe('browser canary callback persistence', () => {
  it('authenticates once and never overwrites the accepted result', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const token = 'a'.repeat(48);
    const [run] = await db
      .insert(canaryRuns)
      .values({
        browserCallbackTokenHash: createHash('sha256').update(token).digest('hex'),
      })
      .returning();
    expect(run).toBeDefined();
    try {
      const forged = await recordCanaryBrowserResult(db, {
        runId: run?.id ?? '',
        token: 'b'.repeat(48),
        result: { ok: false },
      });
      expect(forged).toMatchObject({ ok: false, status: 403 });

      const accepted = await recordCanaryBrowserResult(db, {
        runId: run?.id ?? '',
        token,
        result: { ok: true, outputs: ['first'] },
      });
      expect(accepted).toEqual({ ok: true, duplicate: false });

      const replay = await recordCanaryBrowserResult(db, {
        runId: run?.id ?? '',
        token,
        result: { ok: false, outputs: ['overwrite'] },
      });
      expect(replay).toEqual({ ok: true, duplicate: true });

      const [stored] = await db
        .select()
        .from(canaryRuns)
        .where(eq(canaryRuns.id, run?.id ?? ''));
      expect(stored?.browserResult).toEqual({ ok: true, outputs: ['first'] });
    } finally {
      if (run) await db.delete(canaryRuns).where(eq(canaryRuns.id, run.id));
    }
  });
});
