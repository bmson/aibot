import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { EvidenceStore, verifyEvidenceChain } from './cutover-evidence.js';
import {
  type CutoverConfig,
  configSha256,
  databaseDependencies,
  type Inventory,
  isDatabaseSecretName,
  readCutoverConfig,
  STEPS,
} from './cutover-steps.js';

/**
 * Builds the PostgreSQL retirement evidence report from the cutover evidence,
 * the repository, and (optionally) a fresh read-only Cloud Run inventory. The
 * report is READY only when deleting the Neon database would remove no
 * remaining runtime or recovery dependency, and every asset reference without
 * recoverable bytes has an explicit owner accepted-loss decision.
 */

export type OwnerDecisions = {
  /** One entry per unresolved asset reference from the assets step. */
  acceptedLosses?: Array<{
    sourceRecordId: string;
    decision: 'accepted-loss';
    decidedBy: string;
    decidedAt: string;
    reason: string;
  }>;
  /** The separately retained PostgreSQL archive (retirement gate 7). */
  postgresArchive?: {
    uri: string;
    generation: string;
    sha256: string;
    restoreTestedAt: string;
    retainedUntil: string;
  };
};

export type DependencyClass =
  | 'release-pipeline'
  | 'backup-tooling'
  | 'terraform'
  | 'ci-workflow'
  | 'unclassified'
  | 'application-code'
  | 'migration-tooling'
  | 'operator-script'
  | 'tests'
  | 'local-development'
  | 'documentation';

/** Classes whose presence means deleting Neon would break something still in use. */
const BLOCKING_CLASSES = new Set<DependencyClass>([
  'release-pipeline',
  'backup-tooling',
  'terraform',
  'ci-workflow',
  'unclassified',
]);

const CLASS_NOTES: Record<DependencyClass, string> = {
  'release-pipeline':
    'A release would redeploy DATABASE_URL onto services or run the PostgreSQL migration/backup job.',
  'backup-tooling': 'The PostgreSQL backup path connects to the source database.',
  terraform: 'Infrastructure code would provision or reference the PostgreSQL dependency.',
  'ci-workflow': 'A workflow reaches a non-local PostgreSQL database or its secret.',
  unclassified: 'Not recognized; review before deleting the database.',
  'application-code':
    'PostgreSQL composition code. Inactive while live verification shows no serving template sets DATABASE_URL; delete when the PostgreSQL driver is removed.',
  'migration-tooling':
    'Reads the source only when an operator runs it manually; retire with the database.',
  'operator-script':
    'Manual maintenance script with a PostgreSQL path; port or delete, it is not a runtime or recovery dependency.',
  tests: 'Tests against a local or disposable PostgreSQL database.',
  'local-development': 'Local development defaults (docker compose, .env.example).',
  documentation: 'Documentation references; update wording after retirement.',
};

const PATTERN =
  /DATABASE_URL|database-url|\bneon\b|neon\.tech|pg_dump|pg_restore|postgres(?:ql)?:\/\//i;

/** Files that exist only to perform this migration and retirement. */
const SELF = /^scripts\/cutover[-.]/;
const SELF_REFERENCE = /scripts\/cutover[-.][a-z-]*\.ts/;

export function classifyPath(path: string, line: string): DependencyClass {
  const local = /localhost|127\.0\.0\.1|assistant:assistant@/.test(line);
  if (/\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)tests?\//.test(path) || /\.test\.sh$/.test(path))
    return 'tests';
  if (/\.(md|mdx)$/.test(path) || path.startsWith('docs/')) return 'documentation';
  if (/\.tf$|\.tfvars$|\.tftest\.hcl$/.test(path)) return 'terraform';
  if (
    path === '.env.example' ||
    path === 'docker-compose.yml' ||
    /^vitest\.config|^turbo\.json$/.test(path)
  )
    return 'local-development';
  if (
    /^infra\/gcp\/(deploy|release|release-fast|release-diagnostics)\.sh$|^infra\/gcp\/cloudbuild/.test(
      path,
    )
  )
    return 'release-pipeline';
  if (/^\.github\/workflows\/deploy\.ya?ml$/.test(path)) return 'release-pipeline';
  if (/^infra\/docker\/(backup|database-admin|migrate)/.test(path)) return 'backup-tooling';
  if (
    /workspace-export|workspace-migration-export|workspace-export-job/.test(path) ||
    /^\.github\/workflows\/workspace-(export|import)\.ya?ml$/.test(path)
  )
    return 'migration-tooling';
  if (path.startsWith('.github/workflows/')) return local ? 'tests' : 'ci-workflow';
  if (/^(apps|packages|workers)\//.test(path)) return 'application-code';
  if (path.startsWith('scripts/')) return local ? 'local-development' : 'operator-script';
  if (path.startsWith('infra/')) return 'unclassified';
  return local ? 'local-development' : 'unclassified';
}

export type RepoFinding = { path: string; lines: number[]; class: DependencyClass };

export function scanRepository(files: Array<{ path: string; text: string }>): RepoFinding[] {
  const findings: RepoFinding[] = [];
  for (const file of files) {
    if (SELF.test(file.path) || file.path === 'pnpm-lock.yaml') continue;
    const byClass = new Map<DependencyClass, number[]>();
    file.text.split('\n').forEach((line, index) => {
      // Lines that only name the cutover tooling (for example package.json scripts) are not dependencies.
      if (!PATTERN.test(line) || SELF_REFERENCE.test(line)) return;
      const kind = classifyPath(file.path, line);
      byClass.set(kind, [...(byClass.get(kind) ?? []), index + 1]);
    });
    for (const [kind, lines] of byClass) findings.push({ path: file.path, lines, class: kind });
  }
  return findings.sort((a, b) => a.path.localeCompare(b.path));
}

type Check = { name: string; ok: boolean; detail?: string };

type AssetsEvidence = {
  unresolved: Array<{ sourceRecordId: string; classification: string }>;
  present: number;
  backedUp: number;
  restored: number;
  recoveredVerified: string[];
  backupPrefix: string;
  restorePrefix: string;
};

export function buildRetirementReport(input: {
  config: CutoverConfig;
  store: EvidenceStore;
  findings: RepoFinding[];
  decisions: OwnerDecisions;
  now: Date;
  minObservationHours: number;
  liveInventory?: Inventory;
}) {
  const { config, store, decisions } = input;
  const steps = STEPS.map((step) => ({ step, evidence: store.read(step.index, step.name) }));
  const result = <T>(name: string) =>
    steps.find((item) => item.step.name === name)?.evidence?.result as T | undefined;
  const blocking: Check[] = [];
  const add = (name: string, ok: boolean, detail?: string) => blocking.push({ name, ok, detail });

  // 1. Every cutover step passed under this configuration, with an intact chain.
  const hash = configSha256(config);
  const incomplete = steps.filter(
    (item) => item.evidence?.status !== 'passed' || item.evidence.configSha256 !== hash,
  );
  add(
    'All cutover steps passed under this configuration',
    incomplete.length === 0,
    incomplete.map((item) => item.step.name).join(', ') || undefined,
  );
  const chain = verifyEvidenceChain(
    store,
    STEPS.map((step) => ({ index: step.index, name: step.name })),
  );
  add('Evidence chain is intact', chain.ok, chain.problems.join('; ') || undefined);

  // 2. Observed under real workload after the switch.
  const liveAt = steps.find((item) => item.step.name === 'live-verify')?.evidence?.completedAt;
  const observedHours = liveAt ? (input.now.getTime() - Date.parse(liveAt)) / 3_600_000 : 0;
  add(
    `Firestore production observed for at least ${input.minObservationHours} hours`,
    observedHours >= input.minObservationHours,
    `${observedHours.toFixed(1)} hours since live verification`,
  );

  // 3. Live Cloud Run, Scheduler, and Pub/Sub configuration.
  const live = result<{ inventory: Inventory; services: Array<{ name: string }> }>('live-verify');
  const inventory = input.liveInventory ?? live?.inventory;
  const inventorySource = input.liveInventory ? 'fresh read-only capture' : 'live-verify evidence';
  const cloudDependencies = inventory ? databaseDependencies(inventory) : [];
  add(
    'No Cloud Run service or job references DATABASE_URL or a database secret',
    Boolean(inventory) && cloudDependencies.length === 0,
    cloudDependencies.map((item) => `${item.kind} ${item.name}`).join(', ') || undefined,
  );
  const firestoreHosts = new Set(
    (inventory?.services ?? [])
      .filter((item) => config.services.some((service) => service.name === item.name))
      .map((item) => (item.url ? new URL(item.url).host : null))
      .filter(Boolean),
  );
  const strayJobs = (inventory?.schedulerJobs ?? []).filter(
    (item) =>
      item.state === 'ENABLED' && (!item.targetHost || !firestoreHosts.has(item.targetHost)),
  );
  add(
    'Every enabled Scheduler job targets a Firestore service',
    Boolean(inventory) && strayJobs.length === 0,
    strayJobs.map((item) => item.name).join(', ') || undefined,
  );
  const straySubscriptions = (inventory?.subscriptions ?? []).filter(
    (item) => item.pushHost && !firestoreHosts.has(item.pushHost),
  );
  add(
    'Every push subscription targets a Firestore service',
    Boolean(inventory) && straySubscriptions.length === 0,
    straySubscriptions.map((item) => item.name).join(', ') || undefined,
  );

  // 4. Repository: release pipeline, backups, Terraform, CI.
  const blockingFindings = input.findings.filter((item) => BLOCKING_CLASSES.has(item.class));
  add(
    'No release, backup, Terraform, or CI path depends on the database',
    blockingFindings.length === 0,
    blockingFindings.map((item) => item.path).join(', ') || undefined,
  );
  const liveVerified =
    steps.find((item) => item.step.name === 'live-verify')?.evidence?.status === 'passed';
  add(
    'Application PostgreSQL code is inactive (no serving template sets DATABASE_URL)',
    liveVerified,
  );

  // 5. PostgreSQL-independent recovery exists.
  const backup = result<{
    backup: { documents: number; canonicalHash: string };
    restore: { canonicalHash: string };
    backupPrefix: string;
  }>('firestore-backup');
  add(
    'Managed Firestore backup restored with canonical-hash parity',
    Boolean(backup && backup.backup.canonicalHash === backup.restore.canonicalHash),
  );
  const assets = result<AssetsEvidence>('assets');
  add(
    'Every present asset is backed up and restorable with SHA-256 parity',
    Boolean(assets && assets.backedUp === assets.present && assets.restored === assets.present),
  );
  add(
    `All ${config.assets.expectedRecovered} recovered historical objects are live and backed up`,
    (assets?.recoveredVerified.length ?? 0) === config.assets.expectedRecovered,
  );
  const archive = decisions.postgresArchive;
  add(
    'A separately retained PostgreSQL archive has a tested restore',
    Boolean(
      archive &&
        /^gs:\/\//.test(archive.uri) &&
        /^[0-9a-f]{64}$/.test(archive.sha256) &&
        Date.parse(archive.restoreTestedAt) > 0 &&
        Date.parse(archive.retainedUntil) > input.now.getTime(),
    ),
    archive ? `${archive.uri}#${archive.generation}` : 'no archive recorded in the decisions file',
  );

  // 6. Owner accepted-loss decisions for references with no recoverable bytes.
  const unresolved = assets?.unresolved ?? [];
  const decided = new Map(
    (decisions.acceptedLosses ?? [])
      .filter(
        (item) =>
          item.decision === 'accepted-loss' &&
          item.decidedBy.trim() &&
          item.reason.trim() &&
          Date.parse(item.decidedAt) > 0,
      )
      .map((item) => [item.sourceRecordId, item]),
  );
  const undecided = unresolved.filter((item) => !decided.has(item.sourceRecordId));
  add(
    `Owner accepted-loss decision recorded for all ${unresolved.length} unrecoverable asset references`,
    unresolved.length === config.assets.expectedUnresolved && undecided.length === 0,
    undecided.map((item) => item.sourceRecordId).join(', ') || undefined,
  );

  const snapshot = result<{ exportSecret: string; branch: { id: string } }>('snapshot-branch');
  const fence = result<{ fenceId: string }>('fence');
  const databaseSecrets = (inventory?.secrets ?? []).filter(isDatabaseSecretName);
  return {
    generatedAt: input.now.toISOString(),
    ready: blocking.every((item) => item.ok),
    configSha256: hash,
    inventorySource,
    checks: blocking,
    cloudDependencies,
    strayScheduler: strayJobs.map((item) => item.name),
    straySubscriptions: straySubscriptions.map((item) => item.name),
    repository: input.findings,
    unresolvedAssets: unresolved.map((item) => ({
      ...item,
      decision: decided.get(item.sourceRecordId) ?? null,
    })),
    evidence: {
      fenceId: fence?.fenceId ?? null,
      drainedAt: result<{ drainedAt: string }>('drain-proof')?.drainedAt ?? null,
      snapshot: result<{ snapshot: Record<string, unknown> }>('final-export')?.snapshot ?? null,
      verify:
        result<{ verify: { summary: Record<string, unknown> } }>('verify-import')?.verify.summary ??
        null,
      firestoreBackup: backup ?? null,
      assets: assets
        ? {
            present: assets.present,
            backedUp: assets.backedUp,
            restored: assets.restored,
            backupPrefix: assets.backupPrefix,
            restorePrefix: assets.restorePrefix,
          }
        : null,
      liveServices: live?.services ?? null,
    },
    // What retirement will delete, in order, once the report is READY.
    retirementActions: [
      `Delete the Neon project ${config.neon.projectId} (source branch ${config.neon.branchId}, endpoint ${config.neon.endpointId}${snapshot ? `, snapshot branch ${snapshot.branch.id}` : ''}), or first remove its branch protection.`,
      ...databaseSecrets.map((name) => `Delete Secret Manager secret ${name} (all versions).`),
      'Revoke the Neon API key used for the cutover.',
      'Delete Cloud Run revisions and jobs that still reference database secrets; the PostgreSQL rollback path ends here.',
    ],
  };
}

export type RetirementReport = ReturnType<typeof buildRetirementReport>;

const CLASS_ORDER: DependencyClass[] = [
  'release-pipeline',
  'backup-tooling',
  'terraform',
  'ci-workflow',
  'unclassified',
  'application-code',
  'migration-tooling',
  'operator-script',
  'tests',
  'local-development',
  'documentation',
];

export function renderRetirementReport(report: RetirementReport): string {
  const lines: string[] = [];
  const mark = (ok: boolean) => (ok ? 'PASS' : 'BLOCKED');
  lines.push('# PostgreSQL retirement evidence report', '');
  lines.push(
    `Generated ${report.generatedAt}. Configuration SHA-256 \`${report.configSha256}\`. Cloud inventory: ${report.inventorySource}.`,
    '',
  );
  lines.push(
    report.ready
      ? '**Verdict: READY.** Deleting the Neon database removes no remaining runtime or recovery dependency found by these checks.'
      : '**Verdict: NOT READY.** Do not delete the Neon database. Every BLOCKED row below must pass first.',
    '',
  );
  lines.push('## Gate checks', '', '| Check | Result | Detail |', '| --- | --- | --- |');
  for (const check of report.checks)
    lines.push(
      `| ${check.name} | ${mark(check.ok)} | ${(check.detail ?? '').replaceAll('|', '\\|')} |`,
    );
  lines.push('', '## Cloud configuration still referencing the database', '');
  if (report.cloudDependencies.length === 0) lines.push('None.');
  for (const item of report.cloudDependencies)
    lines.push(
      `- ${item.kind} \`${item.name}\`: ${[...item.databaseEnv, ...item.databaseSecrets].join(', ')}`,
    );
  if (report.strayScheduler.length)
    lines.push(
      `- Scheduler jobs not targeting a Firestore service: ${report.strayScheduler.join(', ')}`,
    );
  if (report.straySubscriptions.length)
    lines.push(
      `- Push subscriptions not targeting a Firestore service: ${report.straySubscriptions.join(', ')}`,
    );
  lines.push('', '## Repository references', '');
  for (const kind of CLASS_ORDER) {
    const findings = report.repository.filter((item) => item.class === kind);
    if (findings.length === 0) continue;
    lines.push(
      `### ${kind}${BLOCKING_CLASSES.has(kind) ? ' (blocking)' : ''}`,
      '',
      CLASS_NOTES[kind],
      '',
    );
    for (const finding of findings)
      lines.push(
        `- \`${finding.path}\` line${finding.lines.length > 1 ? 's' : ''} ${finding.lines.slice(0, 12).join(', ')}${finding.lines.length > 12 ? ', …' : ''}`,
      );
    lines.push('');
  }
  lines.push('## Asset references without recoverable bytes', '');
  if (report.unresolvedAssets.length === 0) lines.push('None.');
  lines.push('| Source record | Classification | Owner decision |', '| --- | --- | --- |');
  for (const item of report.unresolvedAssets)
    lines.push(
      `| \`${item.sourceRecordId}\` | ${item.classification} | ${item.decision ? `accepted loss by ${item.decision.decidedBy} at ${item.decision.decidedAt}: ${item.decision.reason}` : '**required**'} |`,
    );
  lines.push('', '## Cutover evidence', '');
  lines.push('```json', JSON.stringify(report.evidence, null, 2), '```', '');
  lines.push('## Retirement actions once READY', '');
  for (const action of report.retirementActions) lines.push(`1. ${action}`);
  lines.push('');
  return lines.join('\n');
}

const execFileAsync = promisify(execFile);

async function repositoryFiles(repo: string) {
  const { stdout } = await execFileAsync('git', ['-C', repo, 'ls-files', '-z'], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const paths = stdout.split('\0').filter(Boolean);
  const files: Array<{ path: string; text: string }> = [];
  for (const path of paths) {
    const bytes = await readFile(join(repo, path)).catch(() => null);
    if (!bytes || bytes.length > 2_000_000 || bytes.includes(0)) continue;
    files.push({ path, text: bytes.toString('utf8') });
  }
  return files;
}

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: 'string' },
      'evidence-dir': { type: 'string' },
      repo: { type: 'string', default: '.' },
      decisions: { type: 'string' },
      out: { type: 'string' },
      'min-observation-hours': { type: 'string', default: '168' },
      live: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (!values.config || !values['evidence-dir'] || !values.out)
    throw new Error(
      'Usage: pnpm cutover:retirement-report --config cutover.json --evidence-dir DIR --out report.md [--decisions owner-decisions.json] [--live]',
    );
  const config = await readCutoverConfig(values.config);
  const store = new EvidenceStore(values['evidence-dir']);
  const decisions = values.decisions
    ? (JSON.parse(await readFile(values.decisions, 'utf8')) as OwnerDecisions)
    : {};
  let liveInventory: Inventory | undefined;
  if (values.live) {
    // Read-only list/describe calls only.
    const { captureInventory } = await import('./cutover-steps.js');
    const { createReadOnlyDeps } = await import('./cutover.js');
    liveInventory = (await captureInventory(config, createReadOnlyDeps(config))).inventory;
  }
  const report = buildRetirementReport({
    config,
    store,
    findings: scanRepository(await repositoryFiles(values.repo)),
    decisions,
    now: new Date(),
    minObservationHours: Number(values['min-observation-hours']),
    liveInventory,
  });
  await writeFile(values.out, renderRetirementReport(report), { flag: 'wx', mode: 0o600 });
  await writeFile(`${values.out}.json`, `${JSON.stringify(report, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  console.log(JSON.stringify({ ready: report.ready, checks: report.checks }, null, 2));
  if (!report.ready) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
