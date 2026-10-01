import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const supervisor = fileURLToPath(
  new URL('../../../../scripts/repair-codex-supervisor.mjs', import.meta.url),
);
const actionHook = fileURLToPath(
  new URL('../../../../scripts/repair-codex-action.mjs', import.meta.url),
);
it('wraps only the pinned protected execution hook and rejects upstream drift', () => {
  const dir = mkdtempSync(join(tmpdir(), 'repair-action-hook-'));
  try {
    const path = join(dir, 'action.yml');
    const prefix = 'exec env -u NODE_OPTIONS NODE_OPTIONS=--disable-sigusr1 ';
    const original = `${prefix}node --disable-sigusr1 "$ACTION_PATH/dist/main.js" run-codex-exec --safety-strategy "$CODEX_SAFETY_STRATEGY"`;
    writeFileSync(path, original);
    expect(spawnSync(process.execPath, [actionHook, path]).status).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe(
      original.replace(
        'node --disable-sigusr1 "$ACTION_PATH/dist/main.js"',
        'node --disable-sigusr1 "$RUNNER_TEMP/repair-codex-supervisor.mjs" --disable-sigusr1 "$ACTION_PATH/dist/main.js"',
      ),
    );
    expect(spawnSync(process.execPath, [actionHook, path]).status).not.toBe(0);
    writeFileSync(path, 'unrecognized runtime');
    expect(spawnSync(process.execPath, [actionHook, path]).status).not.toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
function run(source: string) {
  const dir = mkdtempSync(join(tmpdir(), 'repair-supervisor-'));
  try {
    const fixture = join(dir, 'fake-codex.cjs');
    const result = join(dir, 'result.json');
    const log = join(dir, 'codex.log');
    writeFileSync(fixture, source);
    const execution = spawnSync(process.execPath, [supervisor, fixture], {
      encoding: 'utf8',
      timeout: 6000,
      env: {
        ...process.env,
        REPAIR_CODEX_REAL_BIN: process.execPath,
        REPAIR_CODEX_RESULT: result,
        REPAIR_CODEX_LOG: log,
        REPAIR_CODEX_TIMEOUT_MS: '800',
        REPAIR_CODEX_COMPLETION_GRACE_MS: '100',
      },
    });
    return { ...execution, log: readFileSync(log, 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const complete = `require('fs').writeFileSync(process.env.REPAIR_CODEX_RESULT, JSON.stringify({reproduced:true,regressionTest:'sample.test.ts',summary:'Fixed'}));`;
it('returns normally after successful coding and preserves diagnostics', () => {
  const result = run(`${complete} console.log('focused test passed');`);
  expect(result.status).toBe(0);
  expect(result.log).toContain('focused test passed');
});
it('recovers a completed result when the coding process never exits', () => {
  const result = run(`${complete} setInterval(() => {}, 1000);`);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('stopping lingering process');
});
it('fails on the real deadline without a complete result and retains the output', () => {
  const result = run(`console.log('still investigating'); setInterval(() => {}, 1000);`);
  expect(result.status).toBe(124);
  expect(result.log).toContain('still investigating');
});
it('does not convert an ordinary failed coding process into success', () => {
  expect(run(`${complete} process.exit(7);`).status).toBe(7);
  expect(
    run(
      `require('fs').writeFileSync(process.env.REPAIR_CODEX_RESULT, '{}'); setInterval(() => {}, 1000);`,
    ).status,
  ).toBe(124);
});
