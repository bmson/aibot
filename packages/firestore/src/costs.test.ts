import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreCostRepository } from './costs.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore, seedBudget } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore atomic cost ledger', () => {
  let store: InstallationStore;
  let costs: FirestoreCostRepository;
  let now: Date;
  beforeEach(async () => {
    now = new Date('2026-09-30T23:59:00Z');
    store = emulatorStore(() => now);
    costs = new FirestoreCostRepository(store);
    await seedBudget(store);
  });
  afterEach(async () => {
    await disposeStore(store);
  });

  it('serializes competing reservations and never over-reserves the daily cap', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => costs.reserve({ source: 'model', estimatedUsd: 0.3 })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect((await costs.totals()).heldUsd).toBe(0.9);
  }, 30_000);

  it('deduplicates reservation retries and rejects conflicting reuse', async () => {
    const input = { source: 'model' as const, estimatedUsd: 0.1, operationId: 'call/one' };
    const results = await Promise.all([costs.reserve(input), costs.reserve(input)]);
    expect(results[0]).toEqual(results[1]);
    expect((await costs.totals()).heldUsd).toBe(0.1);
    await expect(costs.reserve({ ...input, estimatedUsd: 0.2 })).rejects.toThrow('different work');
    await costs.reconcile('call/one', { usd: 0.08 });
    expect((await costs.reserve(input)).ok).toBe(false);
  });

  it('settles once and commits the task spend with the global ledger', async () => {
    await store.doc('tasks', 'task').set({ id: 'task', spentUsd: '0', budgetUsdLimit: '0.2' });
    const reserved = await costs.reserve({ source: 'model', estimatedUsd: 0.1, taskId: 'task' });
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) throw new Error('Fixture failed to reserve');
    await Promise.all([
      costs.reconcile(reserved.reservationId, { usd: 0.07 }),
      costs.reconcile(reserved.reservationId, { usd: 0.07 }),
    ]);
    expect(await costs.totals()).toMatchObject({
      heldUsd: 0,
      dailySpentUsd: 0.07,
      monthlySpentUsd: 0.07,
    });
    expect((await store.doc('tasks', 'task').get()).get('spentUsd')).toBe('0.070000');
    expect((await store.collection('costEvents').get()).size).toBe(1);
  });

  it('counts outstanding holds across day/month rollover and settles into the current period', async () => {
    const reserved = await costs.reserve({ source: 'model', estimatedUsd: 0.9 });
    if (!reserved.ok) throw new Error('Fixture failed to reserve');
    now = new Date('2026-10-01T00:01:00Z');
    expect((await costs.reserve({ source: 'model', estimatedUsd: 0.2 })).ok).toBe(false);
    await costs.reconcile(reserved.reservationId, { usd: 0.8 });
    expect(await costs.totals()).toMatchObject({
      heldUsd: 0,
      dailySpentUsd: 0.8,
      monthlySpentUsd: 0.8,
    });
  });

  it('enforces a task cap and bounds the critical-reply allowance', async () => {
    await store.doc('tasks', 'task').set({ spentUsd: '0', budgetUsdLimit: '0.1' });
    expect((await costs.reserve({ source: 'model', estimatedUsd: 0.105, taskId: 'task' })).ok).toBe(
      false,
    );
    expect(
      (
        await costs.reserve({
          source: 'model',
          estimatedUsd: 0.105,
          taskId: 'task',
          critical: true,
        })
      ).ok,
    ).toBe(true);
    expect(
      (await costs.reserve({ source: 'model', estimatedUsd: 0.01, taskId: 'task', critical: true }))
        .ok,
    ).toBe(false);
  });

  it('release and settlement races converge without leaking or double-subtracting holds', async () => {
    const reserved = await costs.reserve({ source: 'embedding', estimatedUsd: 0.2 });
    if (!reserved.ok) throw new Error('Fixture failed to reserve');
    await Promise.all([
      costs.release(reserved.reservationId),
      costs.reconcile(reserved.reservationId, { usd: 0.15 }),
    ]);
    const totals = await costs.totals();
    expect(totals.heldUsd).toBe(0);
    expect([0, 0.15]).toContain(totals.dailySpentUsd);
  });

  it('cleans stale holds once and excludes a recently created hold', async () => {
    await costs.reserve({ source: 'model', estimatedUsd: 0.2 });
    now = new Date(now.getTime() + 121 * 60_000);
    await costs.reserve({ source: 'model', estimatedUsd: 0.1 });
    expect(await costs.releaseStale()).toBe(1);
    expect(await costs.releaseStale()).toBe(0);
    expect((await costs.totals()).heldUsd).toBe(0.1);
  });

  it('fails closed without budget configuration and rejects invalid values', async () => {
    await store.doc('coordination', 'budget-policy').delete();
    await expect(costs.reserve({ source: 'model', estimatedUsd: 0.1 })).rejects.toThrow(
      'not been initialized',
    );
    await expect(costs.reserve({ source: 'model', estimatedUsd: NaN })).rejects.toThrow();
    await expect(costs.reserve({ source: 'model', estimatedUsd: 0.0000001 })).rejects.toThrow();
  });
});
