import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { type JobInput, parseJobInput } from './input.js';
import { loadProfile, saveProfile } from './profile.js';
import { runSteps } from './steps.js';
import { buildStores } from './storage.js';

/**
 * The Workspace browser job. Credential-free by construction: it receives a
 * plan + one-shot callback token via env, reads/writes only the agent's
 * Workspace storage, and reports back over a single HTTP callback. It has no
 * database access and no API keys. Always exits 0 — failure is a callback
 * payload, not a job retry (the executor's timeout backstop covers total loss).
 */

interface JobResult {
  ok: boolean;
  goal: string;
  outputs: unknown[];
  screenshots: string[];
  finalUrl?: string;
  tracePath?: string;
  profile?: { loaded: boolean; persistedBytes: number };
  error?: string;
  [key: string]: unknown;
}

async function run(input: JobInput): Promise<JobResult> {
  const stores = buildStores(input.storage);
  const encKey = process.env.PROFILE_ENC_KEY ?? '';
  const work = await mkdtemp(path.join(os.tmpdir(), 'browser-job-'));
  const profileDir = path.join(work, 'profile');

  const profileLoaded = input.plan.useProfile
    ? await loadProfile(stores.workspace, profileDir, encKey)
    : false;

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    viewport: { width: 1280, height: 800 },
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 assistant-workspace/0.1',
  });

  let finalUrl: string | undefined;
  let tracePath: string | undefined;
  let stepResult: Awaited<ReturnType<typeof runSteps>>;
  try {
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = context.pages()[0] ?? (await context.newPage());
    stepResult = await runSteps(page, input.plan.steps, {
      taskId: input.taskId,
      workspace: stores.workspace,
    });
    finalUrl = page.url();

    const traceFile = path.join(work, 'trace.zip');
    await context.tracing.stop({ path: traceFile });
    tracePath = `traces/${input.taskId}-${Date.now()}.zip`;
    const { readFile } = await import('node:fs/promises');
    await stores.traces.put(tracePath, await readFile(traceFile), 'application/zip');
  } finally {
    await context.close().catch(() => {});
  }

  let persistedBytes = 0;
  if (input.plan.useProfile) {
    persistedBytes = await saveProfile(stores.workspace, profileDir, encKey).catch((err) => {
      console.error('profile persist failed', err);
      return 0;
    });
  }
  await rm(work, { recursive: true, force: true });

  return {
    ok: stepResult.failedAtStep === undefined,
    goal: input.plan.goal,
    outputs: stepResult.outputs,
    screenshots: stepResult.screenshots,
    finalUrl,
    tracePath,
    profile: { loaded: profileLoaded, persistedBytes },
    ...(stepResult.failedAtStep !== undefined
      ? { error: `plan failed at step ${stepResult.failedAtStep}` }
      : {}),
  };
}

async function postCallback(input: JobInput, result: JobResult): Promise<void> {
  const body = JSON.stringify({
    taskId: input.taskId,
    token: input.callbackToken,
    result,
  });
  const delaysMs = [0, 2_000, 5_000, 15_000];
  for (const [attempt, delay] of delaysMs.entries()) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    try {
      const res = await fetch(input.callbackUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      if (res.ok) return;
      // 4xx other than 409 will not improve with retries
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
    input = parseJobInput(process.env.BROWSER_JOB_INPUT);
  } catch (err) {
    // No input → no callback target; all we can do is log.
    console.error('invalid job input:', err);
    return;
  }

  const started = Date.now();
  const result = await run(input).catch(
    (err): JobResult => ({
      ok: false,
      goal: input.plan?.goal ?? '',
      outputs: [],
      screenshots: [],
      error: String(err).slice(0, 1000),
    }),
  );
  result.durationMs = Date.now() - started;
  console.log(
    JSON.stringify({
      msg: 'browser job finished',
      taskId: input.taskId,
      ok: result.ok,
      durationMs: result.durationMs,
      steps: result.outputs.length,
    }),
  );
  await postCallback(input, result);
}

await main();
process.exit(0);
