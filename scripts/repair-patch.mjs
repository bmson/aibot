/** Runs from a trusted immutable copy OUTSIDE the candidate checkout. Never execute candidate scripts here. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const { repairPathBlocked } = await import(pathToFileURL(process.env.REPAIR_GUARD).href);
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 2_000_000 });
const base = process.env.REPAIR_BASE;
if (!/^[a-f0-9]{40}$/i.test(base ?? '')) throw new Error('Invalid repair base');
if (git('rev-parse', 'HEAD').trim() !== base)
  throw new Error('Coding agent must not commit or change HEAD');
const allowExecutor = process.env.REPAIR_ALLOW_EXECUTOR === 'true';
const untracked = git('ls-files', '--others', '--exclude-standard', '-z')
  .split('\0')
  .filter(Boolean);
for (const path of untracked) {
  if (repairPathBlocked(path, allowExecutor)) throw new Error(`Protected new path: ${path}`);
}
if (untracked.length) git('add', '--', ...untracked);
const files = git('diff', '--name-only', '--no-renames', '-z', base).split('\0').filter(Boolean);
// Only the coding stage may finish without a patch. Verification/publication always require one.
if (!files.length && process.env.REPAIR_ALLOW_NO_CHANGE === 'true') {
  if (!process.env.REPAIR_RESULT || !existsSync(process.env.REPAIR_RESULT))
    throw new Error('Coding agent returned no investigation result; no patch was produced');
  const result = JSON.parse(readFileSync(process.env.REPAIR_RESULT, 'utf8'));
  if (
    result.reproduced !== false ||
    typeof result.summary !== 'string' ||
    !result.summary.trim() ||
    typeof result.regressionTest !== 'string' ||
    !result.regressionTest.trim()
  )
    throw new Error(
      'No-change investigation requires a complete result explaining why no defect was confirmed',
    );
  const summary = result.summary.replace(/\s+/g, ' ').trim().slice(0, 1500);
  if (process.env.GITHUB_OUTPUT)
    writeFileSync(process.env.GITHUB_OUTPUT, `outcome=no_defect\nsummary=${summary}\n`, {
      flag: 'a',
    });
  console.log('Investigation completed without a confirmed defect; no patch will be published.');
  process.exit(0);
}
if (!files.length || files.length > 20)
  throw new Error('Repair must change between 1 and 20 files');
for (const path of files) {
  if (repairPathBlocked(path, allowExecutor)) throw new Error(`Protected changed path: ${path}`);
}
if (!files.some((path) => /(?:\.(?:test|spec)\.tsx?$|(?:Tests|UITests)\/.*\.swift$)/.test(path)))
  throw new Error('A meaningful regression test must be part of the repair');
if (process.env.REPAIR_RESULT) {
  const result = JSON.parse(readFileSync(process.env.REPAIR_RESULT, 'utf8'));
  if (
    result.reproduced !== true ||
    typeof result.regressionTest !== 'string' ||
    !files.includes(result.regressionTest)
  )
    throw new Error('Coding worker did not reproduce the defect and change its regression test');
}
git('add', '--', ...files);
const modes = git('ls-files', '--stage', '-z').split('\0');
for (const line of modes) {
  const path = line.slice(line.indexOf('\t') + 1);
  if (files.includes(path) && !/^100(?:644|755) /.test(line))
    throw new Error(`Symlink/submodule is forbidden: ${path}`);
}
git('diff', '--check', base);
const patch = execFileSync('git', ['diff', '--binary', '--no-renames', base], {
  maxBuffer: 1_000_000,
});
if (patch.length > 100_000) throw new Error('Repair exceeds the 100 KB patch limit');
if (
  process.env.REPAIR_EXPECTED_PATCH &&
  !patch.equals(readFileSync(process.env.REPAIR_EXPECTED_PATCH))
)
  throw new Error('Candidate checks changed the verified patch');
writeFileSync(process.env.REPAIR_PATCH, patch);
console.log(`Validated ${files.length} changed file(s).`);

if (process.env.GITHUB_OUTPUT)
  writeFileSync(
    process.env.GITHUB_OUTPUT,
    `outcome=patch\nios=${files.some((path) => path.startsWith('apps/ios/'))}\n`,
    { flag: 'a' },
  );
