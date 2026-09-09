import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resetConfigForTest } from './config.js';
import {
  createCloudTasksQueue,
  getQueueNotifier,
  getTaskQueue,
  queueTaskId,
  resetQueueNotifierForTest,
} from './queue.js';

describe('Cloud Tasks queue notifier', () => {
  afterEach(() => {
    resetQueueNotifierForTest();
    resetConfigForTest();
    vi.unstubAllGlobals();
  });

  it('asks Cloud Tasks to attach a route-scoped OIDC token', async () => {
    loadConfig({
      QUEUE_DRIVER: 'cloudtasks',
      GCP_PROJECT: 'test-project',
      GCP_LOCATION: 'us-west1',
      CLOUD_TASKS_QUEUE: 'agent-steps',
      AGENT_URL: 'https://agent.example.test',
      INTERNAL_OIDC_AUDIENCE: 'https://agent.example.test',
      INTERNAL_OIDC_SERVICE_ACCOUNT: 'invoker@test-project.iam.gserviceaccount.com',
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ access_token: 'metadata-access-token' }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    getQueueNotifier().notify('task-123', 7);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const [, request] = fetchMock.mock.calls[1] ?? [];
    const body = JSON.parse(String(request?.body)) as {
      task: {
        name: string;
        httpRequest: {
          url: string;
          headers: Record<string, string>;
          oidcToken: { serviceAccountEmail: string; audience: string };
        };
      };
    };
    expect(body.task.name).toBe(
      `projects/test-project/locations/us-west1/queues/agent-steps/tasks/${queueTaskId('task-123', 7)}`,
    );
    expect(body.task.httpRequest.oidcToken).toEqual({
      serviceAccountEmail: 'invoker@test-project.iam.gserviceaccount.com',
      audience: 'https://agent.example.test/internal/tasks/execute',
    });
    expect(body.task.httpRequest.url).toBe('https://agent.example.test/internal/tasks/execute');
    expect(body.task.httpRequest.headers).not.toHaveProperty('authorization');
  });

  it('fails closed when the OIDC identity is missing', () => {
    loadConfig({ QUEUE_DRIVER: 'cloudtasks', INTERNAL_OIDC_AUDIENCE: '' });
    expect(() => getQueueNotifier()).toThrow('requires INTERNAL_OIDC_AUDIENCE');
  });

  it('uses one stable name per runnable generation and a new name after a wake', () => {
    expect(queueTaskId('task-123', 4)).toBe(queueTaskId('task-123', 4));
    expect(queueTaskId('task-123', 5)).not.toBe(queueTaskId('task-123', 4));
    expect(queueTaskId('other-task', 4)).not.toBe(queueTaskId('task-123', 4));
    expect(() => queueTaskId('task-123', -1)).toThrow('non-negative integer');
  });
  const options = {
    projectId: 'test-project',
    location: 'us-west1',
    queue: 'agent-steps',
    agentUrl: 'https://agent.example.test',
    oidcAudience: 'https://agent.example.test',
    serviceAccountEmail: 'invoker@test-project.iam.gserviceaccount.com',
  };
  it('awaits provider acceptance and includes the generation in the authenticated callback', async () => {
    let accept: (response: Response) => void = () => {};
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise((resolve) => {
          accept = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const queue = createCloudTasksQueue(options, async () => 'test-token');
    let delivered = false;
    const pending = queue.enqueue('task-123', 4).then(() => {
      delivered = true;
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(delivered).toBe(false);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(JSON.parse(Buffer.from(body.task.httpRequest.body, 'base64').toString())).toEqual({
      taskId: 'task-123',
      generation: 4,
    });
    accept(new Response(null, { status: 200 }));
    await pending;
    expect(delivered).toBe(true);
  });
  it('rejects transient failures and unrelated conflicts rather than acknowledging delivery', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ error: { status: 'ABORTED' } }, { status: 409 }))
      .mockResolvedValueOnce(
        Response.json({ error: { status: 'ALREADY_EXISTS' } }, { status: 409 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const queue = createCloudTasksQueue(options, async () => 'test-token');
    await expect(queue.enqueue('task', 0)).rejects.toThrow('(503)');
    await expect(queue.enqueue('task', 0)).rejects.toThrow('(409)');
    await expect(queue.enqueue('task', 0)).resolves.toBeUndefined();
    const names = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).task.name);
    expect(new Set(names).size).toBe(1);
  });
  it('refuses to acknowledge durable dispatch through the local no-op driver', () => {
    loadConfig({ QUEUE_DRIVER: 'local' });
    expect(() => getTaskQueue()).toThrow('requires cloudtasks');
  });

  it('treats Cloud Tasks ALREADY_EXISTS as successful deduplication', async () => {
    loadConfig({
      QUEUE_DRIVER: 'cloudtasks',
      GCP_PROJECT: 'test-project',
      GCP_LOCATION: 'us-west1',
      CLOUD_TASKS_QUEUE: 'agent-steps',
      AGENT_URL: 'https://agent.example.test',
      INTERNAL_OIDC_AUDIENCE: 'https://agent.example.test',
      INTERNAL_OIDC_SERVICE_ACCOUNT: 'invoker@test-project.iam.gserviceaccount.com',
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ access_token: 'metadata-access-token' }))
      .mockResolvedValueOnce(
        Response.json({ error: { status: 'ALREADY_EXISTS' } }, { status: 409 }),
      );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', fetchMock);

    getQueueNotifier().notify('task-123', 7);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
