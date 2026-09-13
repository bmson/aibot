import { spawn } from 'node:child_process';

/** Explicit emulator-only entry point: never target a real database or silently skip. */
const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host)) {
  throw new Error(
    'Start the Firestore emulator and set FIRESTORE_EMULATOR_HOST=127.0.0.1:8789. This command never uses a cloud database.',
  );
}
const response = await fetch(`http://${host}`, { signal: AbortSignal.timeout(5000) });
if (!response.ok) throw new Error('The Firestore emulator is not ready');
const child = spawn(
  'pnpm',
  [
    'exec',
    'vitest',
    'run',
    'packages/firestore',
    'packages/persistence',
    'apps/agent/src/firestore-dispatch.test.ts',
    'apps/agent/src/firestore-schedule.test.ts',
    'apps/agent/src/firestore-approval.test.ts',
    'apps/agent/src/firestore-model-routing.test.ts',
    'apps/agent/src/firestore-runtime-smoke.test.ts',
    'apps/agent/src/firestore-executor.test.ts',
    'packages/tools/src/dispatcher.firestore.test.ts',
    ...process.argv.slice(2),
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, GCLOUD_PROJECT: 'demo-assistant-test' },
  },
);
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
