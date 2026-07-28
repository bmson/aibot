import { createHash } from 'node:crypto';
import { loadConfig } from './config.js';

/**
 * Queue notifier: pokes the executor about a runnable task.
 * local  → no-op (the in-process poller claims due tasks within ~2s)
 * cloudtasks → creates a Cloud Tasks HTTP task → POST /internal/tasks/execute
 * Fire-and-forget semantics everywhere: the 1-minute sweeper is the backstop,
 * so a lost notification delays work, never loses it.
 */
export interface QueueNotifier {
  /**
   * `generation` changes whenever a task becomes runnable again. Cloud Tasks
   * deduplicates the stable (taskId, generation) name while still permitting a
   * later approval, retry, sleep wake-up, or reclaimed lease to enqueue anew.
   */
  notify(taskId: string, generation: number): void;
}

let cached: QueueNotifier | undefined;

export function queueTaskId(taskId: string, generation: number): string {
  if (!Number.isInteger(generation) || generation < 0) {
    throw new Error('queue generation must be a non-negative integer');
  }
  const digest = createHash('sha256').update(`${taskId}:${generation}`).digest('hex').slice(0, 32);
  return `task-${digest}`;
}

export function getQueueNotifier(): QueueNotifier {
  if (cached) return cached;
  const config = loadConfig();

  if (config.QUEUE_DRIVER !== 'cloudtasks') {
    cached = { notify: () => {} };
    return cached;
  }

  const {
    GCP_PROJECT,
    GCP_LOCATION,
    CLOUD_TASKS_QUEUE,
    AGENT_URL,
    INTERNAL_OIDC_AUDIENCE,
    INTERNAL_OIDC_SERVICE_ACCOUNT,
  } = config;
  if (!INTERNAL_OIDC_AUDIENCE || !INTERNAL_OIDC_SERVICE_ACCOUNT) {
    throw new Error('cloudtasks queue requires INTERNAL_OIDC_AUDIENCE and service account');
  }
  const callbackUrl = new URL('/internal/tasks/execute', AGENT_URL).toString();
  const callbackAudience = new URL('/internal/tasks/execute', INTERNAL_OIDC_AUDIENCE).toString();
  const queuePath = `projects/${GCP_PROJECT}/locations/${GCP_LOCATION}/queues/${CLOUD_TASKS_QUEUE}`;

  // Metadata tokens live ~an hour; refetching per enqueue added a round trip
  // to every notify. Reuse until five minutes before expiry.
  let tokenCache: { value: string; expiresAtMs: number } | undefined;
  async function accessToken(): Promise<string> {
    if (tokenCache && Date.now() < tokenCache.expiresAtMs) return tokenCache.value;
    const res = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5_000) },
    );
    if (!res.ok) throw new Error(`metadata token fetch failed: ${res.status}`);
    const data = (await res.json()) as { access_token: string; expires_in?: number };
    tokenCache = {
      value: data.access_token,
      expiresAtMs: Date.now() + (Math.max(0, data.expires_in ?? 0) - 300) * 1000,
    };
    return data.access_token;
  }

  cached = {
    notify(taskId: string, generation: number) {
      const name = `${queuePath}/tasks/${queueTaskId(taskId, generation)}`;
      void (async () => {
        const token = await accessToken();
        const res = await fetch(`https://cloudtasks.googleapis.com/v2/${queuePath}/tasks`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            task: {
              name,
              httpRequest: {
                httpMethod: 'POST',
                url: callbackUrl,
                headers: {
                  'content-type': 'application/json',
                },
                oidcToken: {
                  serviceAccountEmail: INTERNAL_OIDC_SERVICE_ACCOUNT,
                  audience: callbackAudience,
                },
                body: Buffer.from(JSON.stringify({ taskId })).toString('base64'),
              },
            },
          }),
          signal: AbortSignal.timeout(15_000),
        });
        // An existing name means this runnable generation is already queued.
        // Treat it as success: the whole point of the explicit name is for
        // enqueue + sweeper races to converge here without duplicate work.
        if (!res.ok && res.status !== 409) {
          console.error(`cloud tasks notify failed (${res.status}) — sweeper will pick it up`);
        }
      })().catch((err) => console.error('queue notify error', err));
    },
  };
  return cached;
}

/** Test seam. */
export function resetQueueNotifierForTest(): void {
  cached = undefined;
}
