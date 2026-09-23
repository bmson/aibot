import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getFirestoreMobileCosts } from './mobile-costs.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore, seedBudget } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore mobile cost dashboard', () => {
  let store: InstallationStore;
  beforeEach(async () => {
    store = emulatorStore(() => new Date('2026-09-22T12:00:00Z'));
    await seedBudget(store);
    await Promise.all([
      store.doc('coordination', 'budget-holds').set({ heldMicros: 20_000 }),
      store.doc('budgetPeriods', 'day:2026-09-22').set({ spentMicros: 50_200 }),
      store.doc('budgetPeriods', 'month:2026-09').set({ spentMicros: 50_200 }),
      store.doc('budgets', 'task_default').set({ scope: 'task_default', limitUsd: '0.50' }),
      store.doc('agents', 'owner').set({
        id: 'owner',
        name: 'Owner',
        timezone: 'America/Los_Angeles',
        locale: 'en-US',
        signature: '',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      }),
      store.doc('agents', 'foreign').set({
        id: 'foreign',
        name: 'Foreign',
        timezone: 'Europe/London',
        createdAt: new Date('2025-01-01T00:00:00Z'),
      }),
      store
        .doc('tasks', 'task-a')
        .set({ id: 'task-a', type: 'chat', progress: 'Running', status: 'waiting_budget' }),
      store.doc('costReservations', 'hold').set({
        id: 'hold',
        source: 'model',
        description: 'Next call',
        estimatedUsd: '0.020000',
        status: 'held',
        createdAt: new Date('2026-09-22T11:00:00Z'),
      }),
    ]);
  });
  afterEach(async () => {
    await disposeStore(store);
  });

  it('reads every page and preserves owner-scoped dashboard totals', async () => {
    const batchOne = store.db.batch();
    const batchTwo = store.db.batch();
    for (let index = 0; index < 501; index++) {
      (index < 450 ? batchOne : batchTwo).set(store.doc('costEvents', `event-${index}`), {
        id: `event-${index}`,
        taskId: 'task-a',
        source: 'model',
        description: 'Model call',
        usd: '0.000100',
        createdAt: new Date(Date.UTC(2026, 8, 22, 0, 0, index)),
      });
    }
    batchTwo.set(store.doc('costEvents', 'other'), {
      id: 'other',
      taskId: null,
      source: 'external_api',
      description: 'Other charge',
      usd: '0.000100',
      createdAt: new Date('2026-09-22T11:00:00Z'),
    });
    batchTwo.set(store.doc('costEvents', 'old'), {
      id: 'old',
      taskId: null,
      source: 'model',
      description: 'Last month',
      usd: '99.000000',
      createdAt: new Date('2026-08-31T23:59:59Z'),
    });
    batchTwo.set(store.doc('modelCalls', 'model-one'), {
      id: 'model-one',
      model: 'gemini-2.5-flash',
      costUsd: '0.004000',
      createdAt: new Date('2026-09-22T09:00:00Z'),
    });
    await batchOne.commit();
    await batchTwo.commit();

    const dashboard = await getFirestoreMobileCosts(store, 'owner');
    expect(dashboard.timezone).toBe('America/Los_Angeles');
    expect(dashboard.totals).toMatchObject({ monthlySpentUsd: 0.0502, heldUsd: 0.02 });
    expect(dashboard.bySource).toEqual([
      { source: 'model', usd: '0.050100', count: 501 },
      { source: 'external_api', usd: '0.000100', count: 1 },
    ]);
    expect(dashboard.byModel).toEqual([{ model: 'gemini-2.5-flash', usd: '0.004000', count: 1 }]);
    expect(dashboard.topTasks).toEqual([
      { taskId: 'task-a', usd: '0.050100', type: 'chat', progress: 'Running' },
    ]);
    expect(dashboard.held).toEqual([
      { id: 'hold', source: 'model', description: 'Next call', estimatedUsd: '0.020000' },
    ]);
    expect(dashboard.recent[0]?.id).toBe('other');
    expect(dashboard.parkedTasks).toBe(1);
    expect(dashboard.taskDefaultLimit).toBe('0.50');
  }, 30_000);

  it('refuses a dashboard read while owner privacy erasure is active', async () => {
    await store.doc('privacyErasureJobs', 'owner').set({ agentId: 'owner', status: 'active' });
    await expect(getFirestoreMobileCosts(store, 'owner')).rejects.toThrow(
      'Privacy erasure is in progress',
    );
    await expect(getFirestoreMobileCosts(store, 'missing')).rejects.toThrow(
      'Cost dashboard owner is missing',
    );
  });
});
