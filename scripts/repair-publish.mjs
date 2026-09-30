/** Run only on a fresh checkout after verification; the generated application is never executed here. */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const id = process.env.REPAIR_ID;
if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id ?? ''))
  throw new Error('Invalid repair ID');
const repo = process.env.GITHUB_REPOSITORY;
if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error('Invalid repository');
const baseBranch = process.env.REPAIR_DEFAULT_BRANCH;
if (!/^[\w./-]+$/.test(baseBranch ?? '') || baseBranch.startsWith('-') || baseBranch.includes('..'))
  throw new Error('Invalid base branch');
const brief = JSON.parse(process.env.REPAIR_BRIEF ?? '{}');
for (const key of ['diagnosis', 'reproduction', 'acceptance'])
  if (typeof brief[key] !== 'string' || brief[key].length > 1500)
    throw new Error('Invalid technical brief');
const branch = `codex/self-repair-${id}`;
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1_000_000 });
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1_000_000 });
const existing = JSON.parse(
  gh('pr', 'list', '--repo', repo, '--state', 'all', '--head', branch, '--json', 'url,number'),
);
if (existing.length) {
  console.log(existing[0].url);
  process.exit(0);
}
// A remote branch without a PR can be recovered, but never force-push or overwrite it.
gh('auth', 'setup-git');
const remote = git('ls-remote', '--heads', 'origin', branch).trim();
git('switch', '-c', branch);
git('config', 'user.name', 'Assistant self-repair');
git('config', 'user.email', 'self-repair@users.noreply.github.com');
git('-c', 'core.hooksPath=/dev/null', 'commit', '-m', `Fix assistant issue ${id}`);
const commit = git('rev-parse', 'HEAD').trim();
if (remote && !remote.startsWith(commit + '\t'))
  throw new Error('Repair branch already exists with a different commit; manual recovery required');
if (!remote) git('-c', 'core.hooksPath=/dev/null', 'push', 'origin', `HEAD:refs/heads/${branch}`);
const bodyPath = `${process.env.RUNNER_TEMP}/repair-pr-body.md`;
const body = `Fixes assistant reliability issue ${id}.\n\n${brief.diagnosis}\n\nReproduction: ${brief.reproduction}\n\nExpected behavior: ${brief.acceptance}\n\nThis change was prepared by the isolated coding worker and passed lint, type checking, the PostgreSQL test suite, and the Firestore emulator suite. Required PR checks, including applicable iOS validation, must pass before merge.\n\nReview the original report and diagnosis in the assistant’s Improvements page. Raw conversation and audit contents are intentionally omitted.\n\nThe owner reviews and merges this PR. Deployment and confirmation of the original behavior are tracked separately.\n\nWorker run: https://github.com/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}\n`;
writeFileSync(bodyPath, body);
console.log(
  gh(
    'pr',
    'create',
    '--repo',
    repo,
    '--base',
    baseBranch,
    '--head',
    branch,
    '--title',
    `Fix assistant issue ${id.slice(0, 8)}`,
    '--body-file',
    bodyPath,
    '--label',
    'self-maintenance',
  ),
);
