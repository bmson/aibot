import { randomUUID } from 'node:crypto';
import { loadConfig } from '@assistant/config';
import type { Db } from '@assistant/db';
import {
  createFirestoreExecutionPersistence,
  FirestoreReminderRepository,
  FirestoreScheduleRepository,
} from '@assistant/firestore';
import {
  googleModule,
  installModules,
  noopOwnerNotifier,
  remindersModule,
} from '@assistant/modules';
import type { TaskQueue } from '@assistant/persistence';
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
import { executeAgentTask } from './task-runner.js';

const TIMEZONE = 'America/Los_Angeles';

/**
 * Cloud Tasks mode has no local poller: the scheduled sweep is the only
 * dispatcher, and delivery lands on /internal/tasks/execute. These drive the
 * same functions against the emulator with a recording queue in place of the
 * Cloud Tasks API, and a SQL handle that throws on any access.
 */
describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore agent with Cloud Tasks', () => {
  const agentId = randomUUID();
  let store: InstallationStore;
  let deps: AgentDeps;
  let sqlAccesses: string[];
  let enqueued: Array<{ taskId: string; generation: number }>;
  let failEnqueue: boolean;
  let queue: TaskQueue;

  beforeEach(async () => {
    vi.stubEnv('METADATA_SERVER_DETECTION', 'none');
    store = emulatorStore();
    sqlAccesses = [];
    enqueued = [];
    failEnqueue = false;
    queue = {
      enqueue: async (taskId, generation) => {
        if (failEnqueue) throw new Error('Cloud Tasks enqueue failed (503)');
        enqueued.push({ taskId, generation });
      },
    };
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
      QUEUE_DRIVER: 'cloudtasks' as const,
      FIRESTORE_AGENT_ID: agentId,
      ASSISTANT_MODULES: ['reminders' as const],
    };
    const persistence = createFirestoreExecutionPersistence(store, agentId, {
      provider: 'synthetic',
      model: 'cloudtasks-fixture',
      dimensions: 1536,
      revision: '1',
    });
    const registry = new ToolRegistry();
    // google is composed but not enabled, so its deterministic task kinds are
    // known and complete benignly: an execution path with no model or SQL.
    const modules = installModules([googleModule, remindersModule], {
      config,
      db,
      registry,
      repoRoot: '/tmp/test',
      router: unavailable('router') as never,
      workspace: unavailable('workspace') as never,
      workspacePrefix: 'workspace/test',
      workspaceRoot: '/tmp/test',
      persistence,
      portableReminders: {
        schedules: new FirestoreScheduleRepository(store),
        reminders: new FirestoreReminderRepository(store),
        getTimezone: async () => TIMEZONE,
      },
    });
    deps = {
      config,
      db,
      firestoreStore: store,
      firestoreTasks: persistence.tasks,
      persistence,
      router: unavailable('router') as never,
      registry,
      dispatcher: unavailable('dispatcher') as never,
      workspace: unavailable('workspace') as never,
      modules,
      outOfBandNotifier: noopOwnerNotifier,
    };
    await seedBudget(store);
    await store.doc('agents', agentId).set({ id: agentId, name: 'Owner', timezone: TIMEZONE });
  });

  afterEach(async () => {
    await disposeStore(store);
    vi.unstubAllEnvs();
  });

  async function sweep() {
    const result = await runFirestoreSweep(deps, { queue });
    if (!result.ready) throw new Error(result.error);
    return result.report;
  }

  async function createTask(runAfter?: Date) {
    const tasks = deps.firestoreTasks;
    if (!tasks) throw new Error('missing tasks');
    const { task } = await tasks.createTask({
      agentId,
      type: 'adhoc',
      trust: 'assistant',
      trigger: { source: 'internal', payload: {} },
      ...(runAfter ? { runAfter } : {}),
    });
    return task;
  }

  it('dispatches each wake intent once under its task generation', async () => {
    const task = await createTask();
    const later = await createTask(new Date(Date.now() + 3_600_000));

    expect(await sweep()).toMatchObject({ wakeIntentsDispatched: 1, wakeIntentErrors: 0 });
    expect(enqueued).toEqual([{ taskId: task.id, generation: 0 }]);
    expect(await sweep()).toMatchObject({ wakeIntentsDispatched: 0 });
    expect(enqueued).toHaveLength(1);
    expect(enqueued.some((item) => item.taskId === later.id)).toBe(false);
    expect(await deps.firestoreTasks?.claim(task.id, 0)).not.toBeNull();
    expect(sqlAccesses).toEqual([]);
  });

  it('keeps an undelivered intent pending after a provider failure and delivers it later', async () => {
    const task = await createTask();
    failEnqueue = true;
    expect(await sweep()).toMatchObject({ wakeIntentsDispatched: 0, wakeIntentsRetrying: 1 });
    const intents = await store.collection('outbox').get();
    expect(intents.docs.map((doc) => doc.get('status'))).toEqual(['pending']);
    await intents.docs[0]?.ref.update({ availableAt: new Date(0) });
    failEnqueue = false;
    expect(await sweep()).toMatchObject({ wakeIntentsDispatched: 1 });
    expect(enqueued).toEqual([{ taskId: task.id, generation: 0 }]);
    expect(sqlAccesses).toEqual([]);
  });

  it('reclaims an expired lease and dispatches the recovered generation', async () => {
    const task = await createTask();
    await sweep();
    const lease = await deps.firestoreTasks?.claim(task.id, 0);
    if (!lease) throw new Error('claim failed');
    await store.doc('tasks', task.id).update({ lockedUntil: new Date(Date.now() - 1_000) });

    expect(await sweep()).toMatchObject({ reclaimedTaskLeases: 1, wakeIntentsDispatched: 1 });
    expect(enqueued.at(-1)).toEqual({ taskId: task.id, generation: 1 });
    expect(sqlAccesses).toEqual([]);
  });

  it('fires a schedule and dispatches it in the same pass without the local poller', async () => {
    const create = deps.registry.get('reminder.create')?.tool;
    if (!create) throw new Error('reminder.create missing');
    const now = new Date();
    await create.execute({ text: 'Stretch', inMinutes: 1 }, {
      taskId: randomUUID(),
      agentId,
      trust: 'owner',
      tainted: false,
      db: deps.db,
      now: () => new Date(now.getTime() - 120_000),
      signal: new AbortController().signal,
      log: async () => {},
    } as never);

    expect(await sweep()).toMatchObject({ schedulesFired: 1, wakeIntentsDispatched: 1 });
    const [delivery] = enqueued;
    const fired = await deps.firestoreTasks?.getTask(delivery?.taskId ?? '');
    expect(fired?.trigger).toMatchObject({ payload: { job: 'reminder.notify' } });
    expect(delivery?.generation).toBe(fired?.queueGeneration);
    expect(sqlAccesses).toEqual([]);
  });

  it('executes a dispatched delivery exactly once, as /internal/tasks/execute does', async () => {
    const tasks = deps.firestoreTasks;
    if (!tasks) throw new Error('missing tasks');
    const { task } = await tasks.createTask({
      agentId,
      type: 'adhoc',
      trust: 'assistant',
      trigger: { source: 'internal', payload: { kind: 'application_confirmation' } },
    });
    await sweep();
    const [delivery] = enqueued;
    if (!delivery) throw new Error('task was not dispatched');
    expect(delivery).toEqual({ taskId: task.id, generation: 0 });
    expect(await executeAgentTask(deps, delivery.taskId, delivery.generation)).toMatchObject({
      outcome: 'cancelled',
    });
    // A duplicate Cloud Tasks delivery of the same generation is fenced.
    expect(await executeAgentTask(deps, delivery.taskId, delivery.generation)).toEqual({
      outcome: 'not_claimable',
    });
    expect(sqlAccesses).toEqual([]);
  });
});
