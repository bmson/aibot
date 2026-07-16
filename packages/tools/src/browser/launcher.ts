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

/** Dev: run the worker as a detached child process against the local workspace. */
export class LocalProcessLauncher implements BrowserJobLauncher {
  constructor(private opts: { repoRoot: string; workspaceRoot: string; profileEncKey?: string }) {}

  async launch(input: BrowserJobLaunchInput): Promise<{ executionName?: string }> {
    const jobInput = {
      ...input,
      storage: { driver: 'local', root: this.opts.workspaceRoot } satisfies BrowserJobStorage,
    };
    const child = spawn('pnpm', ['--filter', '@assistant/browser-job', 'start'], {
      cwd: this.opts.repoRoot,
      env: {
        ...process.env,
        BROWSER_JOB_INPUT: JSON.stringify(jobInput),
        PROFILE_ENC_KEY: this.opts.profileEncKey ?? '',
      },
      stdio: 'ignore',
      detached: true,
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
      { headers: { 'Metadata-Flavor': 'Google' } },
    );
    if (!res.ok) throw new Error(`metadata token fetch failed: ${res.status}`);
    return ((await res.json()) as { access_token: string }).access_token;
  }

  async launch(input: BrowserJobLaunchInput): Promise<{ executionName?: string }> {
    const jobInput = { ...input, storage: this.opts.storage };
    const timeoutSeconds = Math.min(input.plan.maxDurationSeconds + 60, 900);
    const url = `https://run.googleapis.com/v2/projects/${this.opts.project}/locations/${this.opts.location}/jobs/${this.opts.jobName}:run`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await this.token()}`,
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
    });
    if (!res.ok) {
      throw new Error(`cloud run job launch failed: ${res.status} ${await res.text()}`);
    }
    const op = (await res.json()) as { metadata?: { name?: string } };
    return { executionName: op.metadata?.name };
  }
}
