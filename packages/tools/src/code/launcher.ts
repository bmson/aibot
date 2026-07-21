import { spawn } from 'node:child_process';
import type { CodeSpec } from '@assistant/core';

/**
 * How the code-execution worker finds its Workspace storage. Like the browser
 * job it is credential-free: GCS access rides the runtime service account
 * (prod) or the local filesystem (dev). No secrets travel through this input.
 */
export interface CodeJobStorage {
  driver: 'gcs' | 'local';
  bucket?: string;
  prefix?: string;
  root?: string;
}

export interface CodeJobLaunchInput {
  taskId: string;
  spec: CodeSpec;
  callbackUrl: string;
  callbackToken: string;
}

export interface CodeJobLauncher {
  launch(input: CodeJobLaunchInput): Promise<{ executionName?: string }>;
}

/**
 * The Cloud Run :run POST may have reached Google even though its response did
 * not reach us. Retrying could start a second run, so the workflow keeps waiting
 * on its already-staged callback token instead of relaunching.
 */
export class AmbiguousCodeJobLaunchError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AmbiguousCodeJobLaunchError';
  }
}

export function isAmbiguousCodeJobLaunchError(
  error: unknown,
): error is AmbiguousCodeJobLaunchError {
  return error instanceof AmbiguousCodeJobLaunchError;
}

/** Dev: run the worker as a detached child process against the local workspace. */
export class LocalCodeProcessLauncher implements CodeJobLauncher {
  constructor(private opts: { repoRoot: string; workspaceRoot: string }) {}

  async launch(input: CodeJobLaunchInput): Promise<{ executionName?: string }> {
    const jobInput = {
      ...input,
      storage: { driver: 'local', root: this.opts.workspaceRoot } satisfies CodeJobStorage,
    };
    // Do not inherit the agent's DB/model/OAuth/Twilio credentials into the
    // process that runs model-authored code. Keep only runtime settings.
    const inherited = Object.fromEntries(
      ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'PNPM_HOME', 'COREPACK_HOME']
        .map((key) => [key, process.env[key]])
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
    const child = spawn('pnpm', ['--filter', '@assistant/code-runner', 'start'], {
      cwd: this.opts.repoRoot,
      env: {
        ...inherited,
        NODE_ENV: 'production',
        CODE_JOB_INPUT: JSON.stringify(jobInput),
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
export class CloudRunCodeJobLauncher implements CodeJobLauncher {
  constructor(
    private opts: { project: string; location: string; jobName: string; storage: CodeJobStorage },
  ) {}

  private async token(): Promise<string> {
    const res = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5_000) },
    );
    if (!res.ok) throw new Error(`metadata token fetch failed: ${res.status}`);
    return ((await res.json()) as { access_token: string }).access_token;
  }

  async launch(input: CodeJobLaunchInput): Promise<{ executionName?: string }> {
    const jobInput = { ...input, storage: this.opts.storage };
    const timeoutSeconds = Math.min(input.spec.timeoutSeconds + 60, 900);
    const url = `https://run.googleapis.com/v2/projects/${this.opts.project}/locations/${this.opts.location}/jobs/${this.opts.jobName}:run`;
    const token = await this.token();
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          overrides: {
            containerOverrides: [
              { env: [{ name: 'CODE_JOB_INPUT', value: JSON.stringify(jobInput) }] },
            ],
            timeout: `${timeoutSeconds}s`,
          },
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new AmbiguousCodeJobLaunchError(
        `cloud run code job launch response was not received: ${String(error)}`,
        { cause: error },
      );
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => 'response body unavailable');
      if (res.status >= 500 || res.status === 408) {
        throw new AmbiguousCodeJobLaunchError(
          `cloud run code job launch outcome is unknown: ${res.status} ${detail}`,
        );
      }
      throw new Error(`cloud run code job launch failed: ${res.status} ${detail}`);
    }
    let op: { metadata?: { name?: string } };
    try {
      op = (await res.json()) as { metadata?: { name?: string } };
    } catch (error) {
      throw new AmbiguousCodeJobLaunchError(
        'cloud run accepted the code job launch but returned an unreadable operation response',
        { cause: error },
      );
    }
    return { executionName: op.metadata?.name };
  }
}
