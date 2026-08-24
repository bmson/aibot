import { spawnSync } from 'node:child_process';

const DEFAULT_DATABASE_URL = 'postgres://assistant:assistant@localhost:5432/assistant';

function testDatabaseUrl(): string {
  const configured = process.env.TEST_DATABASE_URL;
  const url = new URL(configured ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const testName = configured ? name : name.endsWith('_test') ? name : `${name}_test`;
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(testName) || !testName.endsWith('_test')) {
    throw new Error('TEST_DATABASE_URL must target a database whose name ends in _test.');
  }
  url.pathname = `/${testName}`;
  return url.toString();
}

function run(args: string[], databaseUrl: string): void {
  const result = spawnSync('pnpm', args, {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.env.NODE_ENV === 'production') {
  throw new Error('Refusing to run tests with NODE_ENV=production.');
}

const databaseUrl = testDatabaseUrl();
const vitestArgs = process.argv.slice(2);
if (vitestArgs[0] === '--') {
  vitestArgs.shift();
}

run(['--filter', '@assistant/db', 'test:prepare'], databaseUrl);
run(['exec', 'vitest', 'run', ...vitestArgs], databaseUrl);
