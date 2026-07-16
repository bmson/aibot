import { loadConfig } from './config.js';

/**
 * Queue notifier: pokes the executor about a runnable task.
 * local  → no-op (the in-process poller claims due tasks within ~2s)
 * cloudtasks → creates a Cloud Tasks HTTP task → POST /internal/tasks/execute
 * Fire-and-forget semantics everywhere: the 1-minute sweeper is the backstop,
 * so a lost notification delays work, never loses it.
 */
export interface QueueNotifier {
  notify(taskId: string): void;
}

let cached: QueueNotifier | undefined;

export function getQueueNotifier(): QueueNotifier {
  if (cached) return cached;
  const config = loadConfig();

  if (config.QUEUE_DRIVER !== 'cloudtasks') {
    cached = { notify: () => {} };
    return cached;
  }

  const { GCP_PROJECT, GCP_LOCATION, CLOUD_TASKS_QUEUE, AGENT_URL, INTERNAL_API_SECRET } = config;
  const queuePath = `projects/${GCP_PROJECT}/locations/${GCP_LOCATION}/queues/${CLOUD_TASKS_QUEUE}`;

  async function accessToken(): Promise<string> {
    const res = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' } },
    );
    if (!res.ok) throw new Error(`metadata token fetch failed: ${res.status}`);
    const data = (await res.json()) as { access_token: string };
    return data.access_token;
  }

  cached = {
    notify(taskId: string) {
      void (async () => {
        const token = await accessToken();
        const res = await fetch(`https://cloudtasks.googleapis.com/v2/${queuePath}/tasks`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            task: {
              httpRequest: {
                httpMethod: 'POST',
                url: `${AGENT_URL}/internal/tasks/execute`,
                headers: {
                  'content-type': 'application/json',
                  // Route-level shared-secret auth (same gate the sweeper uses)
                  authorization: `Bearer ${INTERNAL_API_SECRET}`,
                },
                body: Buffer.from(JSON.stringify({ taskId })).toString('base64'),
              },
            },
          }),
        });
        if (!res.ok) {
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
