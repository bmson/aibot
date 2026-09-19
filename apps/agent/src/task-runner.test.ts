import { randomUUID } from 'node:crypto';
import { createInstallationStore, FirestoreTaskRepository } from '@assistant/firestore';
import { type InstalledModuleSet, noopOwnerNotifier } from '@assistant/modules';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDeps } from './deps.js';
import { executeAgentTask } from './task-runner.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('agent task repository routing', () => {
  let tasks: FirestoreTaskRepository;
  let close: () => Promise<void>;

  beforeEach(() => {
    vi.stubEnv('METADATA_SERVER_DETECTION', 'none');
    const store = createInstallationStore({
      projectId: 'demo-assistant-test',
      installationId: `task-runner-${randomUUID()}`,
    });
    tasks = new FirestoreTaskRepository(store);
    close = async () => {
      await store.db.recursiveDelete(store.root);
      await store.db.terminate();
    };
  });

  afterEach(async () => {
    await close();
    vi.unstubAllEnvs();
  });

  function deps(modules: InstalledModuleSet): AgentDeps {
    const sqlThrowingDb = new Proxy(
      {},
      {
        get: (_target, property) => {
          throw new Error(`unexpected SQL access: ${String(property)}`);
        },
      },
    );
    return {
      db: sqlThrowingDb,
      persistence: { tasks },
      modules,
      outOfBandNotifier: noopOwnerNotifier,
      config: {},
      router: {},
      registry: {},
      dispatcher: {},
      workspace: {},
    } as unknown as AgentDeps;
  }

  it('dispatches a Firestore task to its deterministic module without SQL', async () => {
    const run = vi.fn(async () => ({ outcome: 'done' as const }));
    const kind = 'firestore_module_dispatch';
    const created = await tasks.createTask({
      agentId: randomUUID(),
      type: 'adhoc',
      trust: 'assistant',
      trigger: { source: 'internal', payload: { kind } },
    });
    const modules = {
      taskHandlerFor: (candidate: string) => (candidate === kind ? { kind, run } : undefined),
      taskKindUnavailable: () => null,
      emailObservers: [],
    } as unknown as InstalledModuleSet;

    await expect(executeAgentTask(deps(modules), created.task.id, 0)).resolves.toEqual({
      outcome: 'done',
    });
    expect(run).toHaveBeenCalledWith(expect.any(Object), created.task.id, 0);
  });

  it('claims and cancels an unavailable module task through Firestore without SQL', async () => {
    const kind = 'removed_module_task';
    const unavailable = 'The owning module is not installed.';
    const created = await tasks.createTask({
      agentId: randomUUID(),
      type: 'adhoc',
      trust: 'assistant',
      trigger: { source: 'internal', payload: { kind } },
    });
    const modules = {
      taskHandlerFor: () => undefined,
      taskKindUnavailable: (candidate: string) => (candidate === kind ? unavailable : null),
      emailObservers: [],
    } as unknown as InstalledModuleSet;

    await expect(executeAgentTask(deps(modules), created.task.id, 0)).resolves.toEqual({
      outcome: 'cancelled',
      detail: unavailable,
    });
    expect(await tasks.getTask(created.task.id)).toMatchObject({
      status: 'cancelled',
      progress: unavailable,
      leaseToken: null,
    });
  });
});
