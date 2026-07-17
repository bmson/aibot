import { spawn } from 'node:child_process';
import type { BrowserPlan } from '@assistant/core';

/**
 * How the browser-job worker finds its Workspace storage. The job is
 * credential-free: GCS access rides the runtime service account (prod) or the
 * local filesystem (dev); the profile encryption key arrives as its own env
 * (Secret Manager–mounted in prod, .env locally) — never through this input.
 */
export interface BrowserJobStorage {
  driver: 'gcs' | 'local';
  /** gcs: workspace bucket + agent prefix */
  bucket?: string;
  prefix?: string;
  /** gcs: trace archive target (30-day lifecycle bucket) */
  tracesBucket?: string;
  tracesPrefix?: string;
  /** local: the agent's workspace root dir */
  root?: string;
}

export interface BrowserJobLaunchInput {
  taskId: string;
  plan: BrowserPlan;
  callbackUrl: string;
  callbackToken: string;
}

export interface BrowserJobLauncher {
  launch(input: BrowserJobLaunchInput): Promise<{ executionName?: string }>;
}

/**
 * The Cloud Run request may have reached Google even though its response did
 * not reach us. Retrying such a POST could start a second browser job, so the
 * workflow must keep waiting on its already-staged callback token instead.
 */
export class AmbiguousBrowserJobLaunchError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AmbiguousBrowserJobLaunchError';
  }
}

export function isAmbiguousBrowserJobLaunchError(
  error: unknown,
): error is AmbiguousBrowserJobLaunchError {
  return error instanceof AmbiguousBrowserJobLaunchError;
}

/** Dev: run the worker as a detached child process against the local workspace. */
export class LocalProcessLauncher implements BrowserJobLauncher {
  constructor(private opts: { repoRoot: string; workspaceRoot: string; profileEncKey?: string }) {}

  async launch(input: BrowserJobLaunchInput): Promise<{ executionName?: string }> {
    const jobInput = {
      ...input,
      storage: { driver: 'local', root: this.opts.workspaceRoot } satisfies BrowserJobStorage,
    };
    // Do not inherit the agent's database/model/OAuth/Twilio credentials into
    // the process that renders hostile web content. Keep only process-runtime
    // settings required to locate pnpm and create temporary files.
    const inherited = Object.fromEntries(
      [
        'PATH',
        'HOME',
        'TMPDIR',
        'LANG',
        'LC_ALL',
        'SHELL',
        'PNPM_HOME',
        'COREPACK_HOME',
        'NODE_EXTRA_CA_CERTS',
      ]
        .map((key) => [key, process.env[key]])
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
    const child = spawn('pnpm', ['--filter', '@assistant/browser-job', 'start'], {
      cwd: this.opts.repoRoot,
      env: {
        ...inherited,
        NODE_ENV: 'production',
        CHROMIUM_SANDBOX: 'true',
        BROWSER_TRACES: 'false',
        BROWSER_JOB_INPUT: JSON.stringify(jobInput),
        PROFILE_ENC_KEY: this.opts.profileEncKey ?? '',
      },
      stdio: 'ignore',
      detached: true,
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
    return { executionName: `local-pid-${child.pid}` };
  }
}

/** Prod: execute the Cloud Run Job with per-run env overrides (metadata-server auth, no SDK). */
export class CloudRunJobLauncher implements BrowserJobLauncher {
  constructor(
    private opts: {
      project: string;
      location: string;
      jobName: string;
      storage: BrowserJobStorage;
    },
  ) {}

  private async token(): Promise<string> {
    const res = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5_000) },
    );
    if (!res.ok) throw new Error(`metadata token fetch failed: ${res.status}`);
    return ((await res.json()) as { access_token: string }).access_token;
  }

  async launch(input: BrowserJobLaunchInput): Promise<{ executionName?: string }> {
    const jobInput = { ...input, storage: this.opts.storage };
    const timeoutSeconds = Math.min(input.plan.maxDurationSeconds + 60, 900);
    const url = `https://run.googleapis.com/v2/projects/${this.opts.project}/locations/${this.opts.location}/jobs/${this.opts.jobName}:run`;
    // Fetching the access token happens before the mutation request and is
    // therefore definitively safe to retry. Only failures from the :run POST
    // itself are classified as ambiguous.
    const token = await this.token();
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          overrides: {
            containerOverrides: [
              { env: [{ name: 'BROWSER_JOB_INPUT', value: JSON.stringify(jobInput) }] },
            ],
            timeout: `${timeoutSeconds}s`,
          },
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new AmbiguousBrowserJobLaunchError(
        `cloud run job launch response was not received: ${String(error)}`,
        { cause: error },
      );
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => 'response body unavailable');
      if (res.status >= 500 || res.status === 408) {
        throw new AmbiguousBrowserJobLaunchError(
          `cloud run job launch outcome is unknown: ${res.status} ${detail}`,
        );
      }
      throw new Error(`cloud run job launch failed: ${res.status} ${detail}`);
    }
    let op: { metadata?: { name?: string } };
    try {
      op = (await res.json()) as { metadata?: { name?: string } };
    } catch (error) {
      throw new AmbiguousBrowserJobLaunchError(
        'cloud run accepted the job launch but returned an unreadable operation response',
        { cause: error },
      );
    }
    return { executionName: op.metadata?.name };
  }
}
