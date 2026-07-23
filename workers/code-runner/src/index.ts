import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CODE_INPUT_PREFIXES, type JobInput, parseJobInput } from './input.js';
import { type BlobStore, buildWorkspace } from './storage.js';

/**
 * The Workspace code-execution job (Phase 13). Credential-free by construction:
 * it receives a script + one-shot callback token via env, runs the script in an
 * ephemeral temp dir, uploads any files the script writes to ./output into the
 * agent's Workspace under code/<taskId>/, and reports back over a single HTTP
 * callback. No database access, no API keys. Always exits 0 — failure is a
 * callback payload, not a job retry (the executor's timeout backstop covers
 * total loss). Network isolation is enforced by the runtime (a Cloud Run Job
 * with no egress connector), not by this process.
 */

interface JobResult {
  ok: boolean;
  goal: string;
  language: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputs: string[];
  timedOut?: boolean;
  error?: string;
  [key: string]: unknown;
}

const MAX_STREAM_BYTES = 256 * 1024; // per stream (stdout / stderr)
const MAX_OUTPUT_FILES = 50;
const MAX_OUTPUT_FILE_BYTES = 20 * 1024 * 1024;

interface ProcessOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run one script file to completion, bounded in time and captured output. */
function runProcess(
  command: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      // MPLCONFIGDIR keeps matplotlib's cache inside the writable temp dir.
      env: { PATH: process.env.PATH, HOME: opts.cwd, TMPDIR: opts.cwd, MPLCONFIGDIR: opts.cwd },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = (buf: string, chunk: Buffer) =>
      buf.length >= MAX_STREAM_BYTES
        ? buf
        : (buf + chunk.toString('utf8')).slice(0, MAX_STREAM_BYTES);
    child.stdout.on('data', (c: Buffer) => {
      stdout = cap(stdout, c);
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr = cap(stderr, c);
    });
    const killer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    child.once('error', (err) => {
      clearTimeout(killer);
      resolve({ exitCode: null, stdout, stderr: stderr || String(err), timedOut });
    });
    child.once('close', (code) => {
      clearTimeout(killer);
      resolve({ exitCode: code, stdout, stderr, timedOut });
    });
  });
}

/** Recursively list files under a dir, relative to it, capped. */
async function listFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (out.length >= MAX_OUTPUT_FILES) break;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full, base)));
    else if (entry.isFile()) out.push(path.relative(base, full));
  }
  return out.slice(0, MAX_OUTPUT_FILES);
}

async function run(input: JobInput): Promise<JobResult> {
  const workspace: BlobStore = buildWorkspace(input.storage);
  const work = await mkdtemp(path.join(os.tmpdir(), 'code-job-'));
  const outputDir = path.join(work, 'output');
  try {
    await mkdir(outputDir, { recursive: true });

    // Stage Workspace inputs into ./input/<as> before the script runs, so a
    // script can read a CSV/doc the model already has (drive.download, an
    // ingested document, a prior code output). Paths are prefix-allowlisted and
    // `as` is a bare filename — neither can escape the input dir.
    if (input.spec.inputs?.length) {
      const inputDir = path.join(work, 'input');
      await mkdir(inputDir, { recursive: true });
      for (const { workspacePath, as } of input.spec.inputs) {
        const rel = workspacePath.replace(/^\/+/, '');
        if (!CODE_INPUT_PREFIXES.some((p) => rel.startsWith(p))) {
          throw new Error(`input path not allowed: ${workspacePath}`);
        }
        if (!/^[\w.-]+$/.test(as)) throw new Error(`unsafe input filename: ${as}`);
        const bytes = await workspace.get(rel);
        await writeFile(path.join(inputDir, as), bytes);
      }
    }

    const isPython = input.spec.language === 'python';
    const scriptFile = path.join(work, isPython ? 'script.py' : 'script.mjs');
    await writeFile(scriptFile, input.spec.source, 'utf8');

    const outcome = await runProcess(
      isPython ? 'python3' : process.execPath,
      isPython ? [scriptFile] : ['--no-warnings', scriptFile],
      { cwd: work, timeoutMs: Math.min(input.spec.timeoutSeconds, 600) * 1000 },
    );

    // Upload whatever the script wrote to ./output into the Workspace.
    const outputs: string[] = [];
    for (const rel of await listFiles(outputDir)) {
      const bytes = await readFile(path.join(outputDir, rel)).catch(() => null);
      if (!bytes || bytes.length === 0 || bytes.length > MAX_OUTPUT_FILE_BYTES) continue;
      const safe = rel.replaceAll('\\', '/').replace(/^\/+/, '');
      const workspacePath = `code/${input.taskId}/${safe}`;
      await workspace.put(workspacePath, bytes, 'application/octet-stream');
      outputs.push(workspacePath);
    }

    return {
      ok: outcome.exitCode === 0 && !outcome.timedOut,
      goal: input.spec.goal,
      language: input.spec.language,
      exitCode: outcome.exitCode,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      outputs,
      ...(outcome.timedOut ? { timedOut: true, error: 'the script exceeded its time limit' } : {}),
      ...(outcome.exitCode !== 0 && !outcome.timedOut
        ? { error: `the script exited with code ${outcome.exitCode}` }
        : {}),
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function postCallback(input: JobInput, result: JobResult): Promise<void> {
  const body = JSON.stringify({ taskId: input.taskId, token: input.callbackToken, result });
  const delaysMs = [0, 2_000, 5_000, 15_000];
  for (const [attempt, delay] of delaysMs.entries()) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    try {
      const res = await fetch(input.callbackUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return;
      if (res.status !== 409 && res.status < 500) {
        console.error(`callback rejected: ${res.status} ${await res.text()}`);
        return;
      }
      console.error(`callback attempt ${attempt + 1} got ${res.status} — retrying`);
    } catch (err) {
      console.error(`callback attempt ${attempt + 1} failed: ${err}`);
    }
  }
  console.error('callback exhausted retries — the task will settle via its timeout backstop');
}

async function main(): Promise<void> {
  let input: JobInput;
  try {
    input = parseJobInput(process.env.CODE_JOB_INPUT);
  } catch (err) {
    console.error('invalid job input:', err);
    return;
  }

  const started = Date.now();
  const result = await run(input).catch(
    (err): JobResult => ({
      ok: false,
      goal: input.spec?.goal ?? '',
      language: input.spec?.language ?? '',
      exitCode: null,
      stdout: '',
      stderr: '',
      outputs: [],
      error: String(err).slice(0, 1000),
    }),
  );
  result.durationMs = Date.now() - started;
  console.log(
    JSON.stringify({
      msg: 'code job finished',
      taskId: input.taskId,
      ok: result.ok,
      durationMs: result.durationMs,
    }),
  );
  await postCallback(input, result);
}

await main();
process.exit(0);
