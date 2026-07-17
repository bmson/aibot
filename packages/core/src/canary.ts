export interface CanaryHealthRun {
  status: string;
  ok: boolean | null;
  startedAt: Date | string;
  finishedAt?: Date | string | null;
}

export interface CanaryHealth {
  ok: boolean;
  state: 'healthy' | 'running' | 'failed' | 'stale' | 'missing';
  detail: string;
  ageMs?: number;
}

const DEFAULT_MAX_AGE_MS = 26 * 60 * 60 * 1_000;
const MAX_RUNNING_AGE_MS = 10 * 60 * 1_000;

function timestamp(value: Date | string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Shared health semantics for the dashboard and authenticated monitoring route. */
export function evaluateCanaryHealth(
  run: CanaryHealthRun | null | undefined,
  options: { now?: Date; maxAgeMs?: number } = {},
): CanaryHealth {
  if (!run) return { ok: false, state: 'missing', detail: 'No canary run has completed yet.' };
  const now = (options.now ?? new Date()).getTime();
  const completedAt = timestamp(run.finishedAt);
  const startedAt = timestamp(run.startedAt);
  const ageMs = Math.max(0, now - (completedAt ?? startedAt ?? now));

  if (run.status === 'running') {
    return ageMs <= MAX_RUNNING_AGE_MS
      ? { ok: false, state: 'running', detail: 'Canary run is in progress.', ageMs }
      : { ok: false, state: 'stale', detail: 'Canary run is stuck in progress.', ageMs };
  }
  if (run.status !== 'completed' || run.ok !== true) {
    return { ok: false, state: 'failed', detail: 'The latest canary run failed.', ageMs };
  }
  if (!completedAt || ageMs > (options.maxAgeMs ?? DEFAULT_MAX_AGE_MS)) {
    return {
      ok: false,
      state: 'stale',
      detail: 'The latest successful canary run is stale.',
      ageMs,
    };
  }
  return { ok: true, state: 'healthy', detail: 'All integration canaries are healthy.', ageMs };
}
