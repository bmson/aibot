import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function checkout() {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-repair-gate-'));
  scratch.push(dir);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const put = (path: string, value: string) => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), value);
  };
  git('init', '-q');
  git('config', 'user.name', 'Repair gate test');
  git('config', 'user.email', 'test@example.invalid');
  put('apps/web/src/sample.ts', 'export const value = 1;\n');
  put('apps/web/src/sample.test.ts', 'export const expected = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'baseline');
  const base = git('rev-parse', 'HEAD').trim();
  // Artifacts are outside the candidate checkout, as in the worker.
  const artifacts = mkdtempSync(join(tmpdir(), 'assistant-repair-artifacts-'));
  scratch.push(artifacts);
  const run = (extra: Record<string, string> = {}) =>
    spawnSync(process.execPath, [join(root, 'scripts/repair-patch.mjs')], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        REPAIR_BASE: base,
        REPAIR_GUARD: join(root, 'packages/persistence/src/repair-guard.ts'),
        REPAIR_PATCH: join(artifacts, 'candidate.patch'),
        ...extra,
      },
    });
  return { dir, git, put, run, patch: join(artifacts, 'candidate.patch') };
}
describe('trusted worker patch gate', () => {
  it('exports the tested patch and rejects mutations after verification', () => {
    const c = checkout();
    c.put('apps/web/src/sample.ts', 'export const value = 2;\n');
    c.put('apps/web/src/sample.test.ts', 'export const expected = 2;\n');
    expect(c.run().status).toBe(0);
    expect(readFileSync(c.patch, 'utf8')).toContain('+export const value = 2;');
    c.put('apps/web/src/sample.ts', 'export const value = 3;\n');
    const result = c.run({ REPAIR_EXPECTED_PATCH: c.patch });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('changed the verified patch');
  });
  it('rejects protected files even when a regression test changes', () => {
    const c = checkout();
    c.put('apps/web/src/sample.test.ts', 'export const expected = 2;\n');
    c.put('apps/web/auth.ts', 'export const bypass = true;\n');
    expect(c.run().stderr).toContain('Protected new path');
  });
  it('rejects symlinks and missing regression tests', () => {
    const c = checkout();
    c.put('apps/web/src/sample.ts', 'export const value = 2;\n');
    expect(c.run().stderr).toContain('regression test');
    c.put('apps/web/src/sample.test.ts', 'export const expected = 2;\n');
    symlinkSync('/etc/passwd', join(c.dir, 'apps/web/src/link.ts'));
    expect(c.run().stderr).toContain('Symlink/submodule');
  });
  it('rejects a worker that committed changes or failed to reproduce the issue', () => {
    const c = checkout();
    c.put('apps/web/src/sample.test.ts', 'export const expected = 2;\n');
    const resultPath = join(tmpdir(), `repair-result-${c.dir.split('/').at(-1)}.json`);
    writeFileSync(
      resultPath,
      JSON.stringify({ reproduced: false, regressionTest: 'apps/web/src/sample.test.ts' }),
    );
    try {
      expect(c.run({ REPAIR_RESULT: resultPath }).stderr).toContain('did not reproduce');
    } finally {
      rmSync(resultPath);
    }
    c.git('add', '.');
    c.git('commit', '-qm', 'forbidden commit');
    expect(c.run().stderr).toContain('must not commit');
  });
});
