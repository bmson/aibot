import { spawnSync } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Config, loadConfig } from '@assistant/config';

type SpawnResult = {
  error?: Error;
  signal: NodeJS.Signals | null;
  status: number | null;
};

export type ReconcileSpawn = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; stdio: 'inherit' },
) => SpawnResult;

const defaultSpawn: ReconcileSpawn = (command, args, options) => spawnSync(command, args, options);

export function runReconcile(
  config: Pick<Config, 'DATABASE_URL'>,
  spawn: ReconcileSpawn = defaultSpawn,
): number {
  const helperPath = fileURLToPath(
    new URL('../../../infra/docker/database-admin.sh', import.meta.url),
  );
  const result = spawn('bash', [helperPath, 'pnpm', 'reconcile:direct'], {
    env: { ...process.env, DATABASE_URL: config.DATABASE_URL },
    stdio: 'inherit',
  });

  if (result.error) {
    console.error('Could not start the database reconcile command.');
    return 1;
  }
  if (result.signal) {
    const signalNumber = osConstants.signals[result.signal];
    return signalNumber ? 128 + signalNumber : 1;
  }
  return typeof result.status === 'number' ? result.status : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    // Resolve configuration before starting the child so .env/default handling
    // remains identical to the other database commands.
    process.exitCode = runReconcile(loadConfig());
  } catch {
    // Do not echo configuration parsing errors: they can contain credentials.
    console.error('Could not load configuration for database reconcile.');
    process.exitCode = 1;
  }
}
