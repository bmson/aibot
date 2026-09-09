import { createHash } from 'node:crypto';
import type { TaskQueue } from '@assistant/persistence';
import { loadConfig } from './config.js';

/** Best-effort legacy notification; the PostgreSQL sweeper remains its backstop. */
export interface QueueNotifier {
  notify(taskId: string, generation: number): void;
}
let cached: QueueNotifier | undefined;
let cachedQueue: TaskQueue | undefined;

export function queueTaskId(taskId: string, generation: number): string {
  if (!taskId || !Number.isSafeInteger(generation) || generation < 0) {
    throw new Error('queue generation must be a non-negative integer and task ID must be present');
  }
  const digest = createHash('sha256').update(`${taskId}:${generation}`).digest('hex').slice(0, 32);
  return `task-${digest}`;
}

export interface CloudTasksOptions {
  projectId: string;
  location: string;
  queue: string;
  agentUrl: string;
  oidcAudience: string;
  serviceAccountEmail: string;
}

/** Awaited transport used by durable dispatch and the legacy notification wrapper. */
export function createCloudTasksQueue(
  options: CloudTasksOptions,
  accessToken: () => Promise<string>,
): TaskQueue {
  if (!options.serviceAccountEmail || !options.oidcAudience)
    throw new Error('cloudtasks queue requires INTERNAL_OIDC_AUDIENCE and service account');
  if (
    !options.projectId ||
    !options.location ||
    !options.queue ||
    !options.serviceAccountEmail ||
    !options.oidcAudience
  )
    throw new Error('cloudtasks queue requires project, location, and queue');
  const callbackUrl = new URL('/internal/tasks/execute', options.agentUrl).toString();
  const callbackAudience = new URL('/internal/tasks/execute', options.oidcAudience).toString();
  const queuePath = `projects/${options.projectId}/locations/${options.location}/queues/${options.queue}`;
  return {
    async enqueue(taskId, generation, signal) {
      const name = `${queuePath}/tasks/${queueTaskId(taskId, generation)}`;
      signal?.throwIfAborted();
      const token = await accessToken();
      signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(15_000);
      const res = await fetch(`https://cloudtasks.googleapis.com/v2/${queuePath}/tasks`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          task: {
            name,
            httpRequest: {
              httpMethod: 'POST',
              url: callbackUrl,
              headers: { 'content-type': 'application/json' },
              oidcToken: {
                serviceAccountEmail: options.serviceAccountEmail,
                audience: callbackAudience,
              },
              body: Buffer.from(JSON.stringify({ taskId, generation })).toString('base64'),
            },
          },
        }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (res.ok) return;
      if (res.status === 409) {
        const error = (await res.json().catch(() => null)) as {
          error?: { status?: string };
        } | null;
        if (error?.error?.status === 'ALREADY_EXISTS') return;
      }
      throw new Error(`Cloud Tasks enqueue failed (${res.status})`);
    },
  };
}

/** Cloud Run service identity; never requires a downloaded service-account key. */
export function createMetadataTokenProvider(): () => Promise<string> {
  let cache: { value: string; expiresAtMs: number } | undefined;
  return async () => {
    if (cache && Date.now() < cache.expiresAtMs) return cache.value;
    const res = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5_000) },
    );
    if (!res.ok) throw new Error(`metadata token fetch failed: ${res.status}`);
    const data = (await res.json()) as { access_token: string; expires_in?: number };
    if (!data.access_token) throw new Error('Metadata response has no access token');
    cache = {
      value: data.access_token,
      expiresAtMs: Date.now() + (Math.max(0, data.expires_in ?? 0) - 300) * 1000,
    };
    return cache.value;
  };
}

/** A local no-op must never acknowledge a durable intent as delivered. */
export function getTaskQueue(): TaskQueue {
  if (cachedQueue) return cachedQueue;
  const config = loadConfig();
  if (config.QUEUE_DRIVER !== 'cloudtasks') throw new Error('Durable dispatch requires cloudtasks');
  cachedQueue = createCloudTasksQueue(
    {
      projectId: config.GCP_PROJECT,
      location: config.GCP_LOCATION,
      queue: config.CLOUD_TASKS_QUEUE,
      agentUrl: config.AGENT_URL,
      oidcAudience: config.INTERNAL_OIDC_AUDIENCE,
      serviceAccountEmail: config.INTERNAL_OIDC_SERVICE_ACCOUNT,
    },
    createMetadataTokenProvider(),
  );
  return cachedQueue;
}

export function getQueueNotifier(): QueueNotifier {
  if (cached) return cached;
  if (loadConfig().QUEUE_DRIVER !== 'cloudtasks') {
    cached = { notify: () => {} };
    return cached;
  }
  const queue = getTaskQueue();
  cached = {
    notify(taskId, generation) {
      void queue
        .enqueue(taskId, generation)
        .catch((err) => console.error('queue notify error', err));
    },
  };
  return cached;
}

export function resetQueueNotifierForTest(): void {
  cached = undefined;
  cachedQueue = undefined;
}
