import { randomUUID } from 'node:crypto';
import { loadConfig } from '@assistant/config';
import { firestoreCodeJobUnavailable } from '@assistant/core';
import type { Db } from '@assistant/db';
import {
  createFirestoreExecutionPersistence,
  FirestoreScheduleRepository,
} from '@assistant/firestore';
import {
  installModules,
  type ModuleSweepStep,
  noopOwnerNotifier,
  watchesModule,
} from '@assistant/modules';
import { ToolRegistry } from '@assistant/tools/registry';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstallationStore } from '../../../packages/firestore/src/store.js';
import {
  disposeStore,
  emulatorStore,
  seedBudget,
} from '../../../packages/firestore/src/test-store.js';
import type { AgentDeps } from './deps.js';
import { runFirestoreSweep } from './firestore-sweep.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore maintenance sweep', () => {
  const agentId = randomUUID();
  let store: InstallationStore;
  let now: Date;
  let deps: AgentDeps;
  let sqlAccesses: string[];
  let sqlStepRuns: number;
  let portableStepRuns: number;

  beforeEach(async () => {
    vi.stubEnv('METADATA_SERVER_DETECTION', 'none');
    now = new Date('2026-09-24T12:00:00.000Z');
    store = emulatorStore(() => now);
    sqlAccesses = [];
    sqlStepRuns = 0;
    portableStepRuns = 0;
    const unavailable = (name: string) =>
      new Proxy(
        {},
        {
          get: (_target, property) => {
            sqlAccesses.push(`${name}.${String(property)}`);
            throw new Error(`Unexpected ${name} access: ${String(property)}`);
          },
        },
      );
    const db = unavailable('db') as Db;
    const config = {
      ...loadConfig({}),
      PERSISTENCE_DRIVER: 'firestore' as const,
      FIRESTORE_AGENT_ID: agentId,
      ASSISTANT_MODULES: ['watches' as const],
    };
    const persistence = createFirestoreExecutionPersistence(store, agentId, {
      provider: 'synthetic',
      model: 'sweep-fixture',
      dimensions: 1536,
      revision: '1',
    });
    const installed = installModules([watchesModule], {
      config,
      db,
      registry: new ToolRegistry(),
      repoRoot: '/tmp/test',
      router: unavailable('router') as never,
      workspace: unavailable('workspace') as never,
      workspacePrefix: 'workspace/test',
      workspaceRoot: '/tmp/test',
      persistence,
    });
    const sqlStep: ModuleSweepStep = {
      name: 'sqlOnlyStep',
      run: async () => {
        sqlStepRuns += 1;
        return 1;
      },
    };
    const portableStep: ModuleSweepStep = {
      name: 'portableStep',
      portable: true,
      run: async (services) => {
        portableStepRuns += 1;
        return services.persistence.driver === 'firestore' ? 1 : 0;
      },
    };
    deps = {
      config,
      db,
      firestoreStore: store,
      firestoreTasks: persistence.tasks,
      persistence,
      router: unavailable('router') as never,
      registry: new ToolRegistry(),
      dispatcher: unavailable('dispatcher') as never,
      workspace: unavailable('workspace') as never,
      modules: { ...installed, sweepSteps: [...installed.sweepSteps, sqlStep, portableStep] },
      outOfBandNotifier: noopOwnerNotifier,
    };
    await seedBudget(store);
    await store.doc('agents', agentId).set({
      id: agentId,
      name: 'Synthetic owner',
      timezone: 'America/Los_Angeles',
    });
  });

  afterEach(async () => {
    await disposeStore(store);
    vi.unstubAllEnvs();
  });

  it('releases stale reservations and runs only portable module steps without SQL', async () => {
    const stale = await persistence().costs.reserve({ source: 'model', estimatedUsd: 0.2 });
    now = new Date(now.getTime() + 121 * 60_000);
    const fresh = await persistence().costs.reserve({ source: 'model', estimatedUsd: 0.1 });
    expect(stale.ok && fresh.ok).toBe(true);

    const result = await runFirestoreSweep(deps);
    expect(result).toEqual({
      ready: true,
      report: {
        expiredApprovalsWoke: 0,
        resumedApprovalTasks: 0,
        renotifiedApprovals: 0,
        expiredWatches: 0,
        schedulesFired: 0,
        releasedReservations: 1,
        expiredInboxWatches: 0,
        webWatchFires: 0,
        portableStep: 1,
      },
    });
    expect((await persistence().costs.totals()).heldUsd).toBe(0.1);
    expect(sqlStepRuns).toBe(0);
    expect(portableStepRuns).toBe(1);
    expect(sqlAccesses).toEqual([]);
  });

  it('fires portable schedules past SQL-only jobs and goal sessions without creating their tasks', async () => {
    const schedules = new FirestoreScheduleRepository(store);
    const due = new Date(Date.now() - 60_000);
    const ensure = (name: string, taskTemplate: Record<string, unknown>) =>
      schedules.ensure({ agentId, name, cron: '0 9 * * *', taskTemplate, nextRunAt: due });
    const dream = await ensure('dream', { type: 'scheduled', job: 'dream.run' });
    const goal = await ensure('goal-session', { type: 'scheduled', goalId: randomUUID() });
    const consolidation = await ensure('memory-consolidation', {
      type: 'scheduled',
      job: 'memory.consolidate',
    });

    const result = await runFirestoreSweep(deps);
    expect(result).toMatchObject({ ready: true, report: { schedulesFired: 1 } });
    const tasks = await store.collection('tasks').get();
    expect(tasks.docs.map((doc) => doc.get('trigger.payload.job'))).toEqual(['memory.consolidate']);
    for (const skipped of [dream, goal, consolidation]) {
      const row = (await store.doc('schedules', skipped.id).get()).data();
      expect(row?.nextRunAt.toDate().getTime()).toBeGreaterThan(Date.now());
    }
    expect(sqlAccesses).toEqual([]);
  });

  it('names every SQL-only code job and leaves portable ones runnable', () => {
    expect(firestoreCodeJobUnavailable('dream.run')).toMatch(/not yet available on Firestore/);
    expect(firestoreCodeJobUnavailable('memory.extract')).not.toBeNull();
    for (const job of [
      'reminder.notify',
      'memory.consolidate',
      'memory.graph_sync',
      'documents.extract',
      'watch.suggest',
    ])
      expect(firestoreCodeJobUnavailable(job)).toBeNull();
    // Unknown names are not code jobs; the executor treats them as model tasks.
    expect(firestoreCodeJobUnavailable('not.a.job')).toBeNull();
  });

  it('runs nothing while an imported workspace awaits activation', async () => {
    await store.doc('coordination', 'migration').set({ status: 'pending_activation' });
    await persistence().costs.reserve({ source: 'model', estimatedUsd: 0.2 });
    now = new Date(now.getTime() + 121 * 60_000);

    expect(await runFirestoreSweep(deps)).toEqual({
      ready: false,
      error: 'Firestore installation is not ready for maintenance',
    });
    expect((await persistence().costs.totals()).heldUsd).toBe(0.2);
    expect(portableStepRuns).toBe(0);
    expect(sqlAccesses).toEqual([]);
  });

  function persistence() {
    const value = deps.persistence;
    if (!value) throw new Error('missing persistence');
    return value;
  }
});
