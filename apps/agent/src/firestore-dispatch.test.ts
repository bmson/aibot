import { randomUUID } from 'node:crypto';
import { createCloudTasksQueue } from '@assistant/core/queue';
import { dispatchOutbox } from '@assistant/core/workflow/dispatch';
import {
  createInstallationStore,
  FirestoreOutbox,
  FirestoreTaskRepository,
  type InstallationStore,
} from '@assistant/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { firestoreTaskSmoke } from '../../../scripts/firestore-task-smoke.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore task-to-queue delivery', () => {
  let store: InstallationStore;
  beforeEach(() => {
    vi.stubEnv('METADATA_SERVER_DETECTION', 'none');
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? ''))
      throw new Error('Requires a loopback emulator');
    store = createInstallationStore({
      projectId: 'demo-assistant-test',
      installationId: `test-${randomUUID()}`,
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllEnvs();
  });
  it('rehearses the same synthetic workload used by live validation', async () => {
    const report = await firestoreTaskSmoke(store);
    expect(report).toMatchObject({
      taskCreation: 'passed',
      externalRateContention: 'passed',
      generationFencing: 'passed',
      sleepWakeRecovery: 'passed',
      cancellation: 'passed',
    });
  }, 30_000);
  it('recovers an accepted dispatch whose acknowledgement was lost without creating another provider task', async () => {
    const tasks = new FirestoreTaskRepository(store);
    const request = {
      agentId: randomUUID(),
      type: 'adhoc',
      trust: 'owner',
      trigger: {},
      externalEventId: randomUUID(),
    };
    const results = await Promise.all([tasks.createTask(request), tasks.createTask(request)]);
    const task = results[0]?.task;
    if (!task) throw new Error('Missing task');
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const intents = await store.collection('outbox').get();
    expect(intents.size).toBe(1);
    const providerTasks = new Map<string, { taskId: string; generation: number }>();
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
        const payload = JSON.parse(String(init?.body));
        const name = payload.task.name;
        if (providerTasks.has(name))
          return Response.json({ error: { status: 'ALREADY_EXISTS' } }, { status: 409 });
        providerTasks.set(
          name,
          JSON.parse(Buffer.from(payload.task.httpRequest.body, 'base64').toString()),
        );
        return new Response(null, { status: 200 });
      }),
    );
    const queue = createCloudTasksQueue(
      {
        projectId: 'test-project',
        location: 'us-west1',
        queue: 'test-queue',
        agentUrl: 'https://agent.example.test',
        oidcAudience: 'https://agent.example.test',
        serviceAccountEmail: 'invoker@test-project.iam.gserviceaccount.com',
      },
      async () => 'test-token',
    );
    const outbox = new FirestoreOutbox(store);
    vi.spyOn(outbox, 'acknowledge').mockRejectedValueOnce(
      new Error('connection lost before acknowledgement'),
    );
    expect(await dispatchOutbox(outbox, queue)).toMatchObject({ delivered: 0, retried: 1 });
    const intent = intents.docs[0];
    if (!intent) throw new Error('Missing intent');
    await intent.ref.update({ availableAt: new Date(0) });
    expect(await dispatchOutbox(outbox, queue)).toMatchObject({ delivered: 1, retried: 0 });
    expect(providerTasks.size).toBe(1);
    expect([...providerTasks.values()]).toEqual([{ taskId: task.id, generation: 0 }]);
    expect(await outbox.due()).toEqual([]);
    expect(await tasks.claim(task.id, 0)).not.toBeNull();
    expect(await tasks.claim(task.id, 0)).toBeNull();
  }, 30_000);
});
