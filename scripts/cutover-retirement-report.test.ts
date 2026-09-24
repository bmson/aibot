import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EvidenceStore } from './cutover-evidence.js';
import {
  buildRetirementReport,
  classifyPath,
  type OwnerDecisions,
  renderRetirementReport,
  scanRepository,
} from './cutover-retirement-report.js';
import { type CutoverConfig, configSha256, type Inventory, STEPS } from './cutover-steps.js';

const config = {
  gcp: { project: 'bmson-assistant', region: 'us-west1', firestoreLocation: 'us-west1' },
  installationId: 'assistant',
  neon: { projectId: 'proud-sun-123', branchId: 'br-main', endpointId: 'ep-main' },
  assets: { expectedRecovered: 12, expectedUnresolved: 5 },
  services: [{ name: 'assistant-web' }, { name: 'assistant-agent' }],
} as unknown as CutoverConfig;

const unresolved = Array.from({ length: 5 }, (_, index) => ({
  sourceRecordId: `missing-${index + 1}`,
  classification: index < 2 ? 'import-original' : 'generated-artifact',
}));

function cleanInventory(): Inventory {
  return {
    capturedAt: '2026-09-24T12:00:00Z',
    services: ['assistant-web', 'assistant-agent'].map((name) => ({
      name,
      url: `https://${name}-x.a.run.app`,
      latestReadyRevision: `${name}-00009`,
      traffic: [{ revision: `${name}-00009`, percent: 100, latest: true }],
      image: 'img@sha256:x',
      envNames: ['PERSISTENCE_DRIVER', 'FIRESTORE_DATABASE_ID'],
      config: { PERSISTENCE_DRIVER: 'firestore' },
      secretRefs: [{ env: 'AUTH_SECRET', secret: 'auth-secret', version: '3' }],
    })),
    jobs: [{ name: 'assistant-processor', image: 'p', envNames: [], secretRefs: [] }],
    schedulerJobs: [
      {
        name: 'assistant-sweep',
        state: 'ENABLED',
        schedule: '* * * * *',
        targetHost: 'assistant-agent-x.a.run.app',
      },
    ],
    queues: [{ name: 'agent-steps', state: 'PAUSED' }],
    subscriptions: [],
    secrets: ['auth-secret', 'database-url', 'database-url-final-export'],
  };
}

function writeEvidence(
  store: EvidenceStore,
  inventory: Inventory,
  options: { skip?: string; liveAt?: string } = {},
) {
  const hash = configSha256(config);
  let previous: string | null = null;
  const results: Record<string, unknown> = {
    fence: { fenceId: 'neon:proud-sun-123:op-1' },
    'drain-proof': { drainedAt: '2026-09-24T09:00:00Z' },
    'snapshot-branch': { branch: { id: 'br-snapshot' }, exportSecret: 'database-url-final-export' },
    'final-export': {
      snapshot: { uri: 'gs://b/snap.json', generation: '9', sha256: 'f'.repeat(64) },
    },
    'verify-import': { verify: { summary: { verified: true, writes: 87517 } } },
    assets: {
      unresolved,
      present: 98,
      backedUp: 98,
      restored: 98,
      recoveredVerified: Array.from({ length: 12 }, (_, index) => `recovered-${index}`),
      backupPrefix: 'gs://backup/assets/',
      restorePrefix: 'gs://backup/restore/',
    },
    'firestore-backup': {
      backup: { documents: 87517, canonicalHash: 'h' },
      restore: { canonicalHash: 'h' },
      backupPrefix: 'gs://b/fs',
    },
    'live-verify': { inventory, services: [{ name: 'assistant-web', ok: true }] },
  };
  for (const step of STEPS) {
    if (step.name === options.skip) break;
    const at =
      step.name === 'live-verify'
        ? (options.liveAt ?? '2026-09-24T12:00:00Z')
        : '2026-09-24T10:00:00Z';
    store.write({
      format: 'assistant-cutover-evidence',
      version: 1,
      step: step.name,
      index: step.index,
      status: 'passed',
      mutating: step.mutating,
      confirmed: step.mutating,
      configSha256: hash,
      previousSha256: previous,
      startedAt: at,
      completedAt: at,
      result: results[step.name] ?? {},
    });
    previous = store.fileSha256(step.index, step.name);
  }
}

const decisions: OwnerDecisions = {
  acceptedLosses: unresolved.map((item) => ({
    sourceRecordId: item.sourceRecordId,
    decision: 'accepted-loss',
    decidedBy: 'owner',
    decidedAt: '2026-10-01T10:00:00Z',
    reason: 'No copy exists on any owner device; derived memories retained.',
  })),
  postgresArchive: {
    uri: 'gs://bmson-assistant-workspace/workspace/assistant/backups/final.dump',
    generation: '123',
    sha256: 'e'.repeat(64),
    restoreTestedAt: '2026-10-01T09:00:00Z',
    retainedUntil: '2027-10-01T00:00:00Z',
  },
};

const cleanRepo = [
  { path: 'apps/web/lib/db.ts', text: 'const url = process.env.DATABASE_URL;' },
  {
    path: '.github/workflows/ci.yml',
    text: '  DATABASE_URL: postgres://assistant:assistant@localhost:5432/assistant',
  },
  { path: 'docs/recovery.md', text: 'The database-url secret.' },
  { path: 'scripts/cutover-steps.ts', text: 'database-url' },
];

function store() {
  return new EvidenceStore(mkdtempSync(join(tmpdir(), 'retirement-')));
}

describe('repository dependency scan', () => {
  it('separates blocking release, backup, Terraform, and CI paths from inactive code and docs', () => {
    expect(classifyPath('infra/gcp/release.sh', '--set-secrets DATABASE_URL=database-url')).toBe(
      'release-pipeline',
    );
    expect(classifyPath('infra/docker/backup.sh', 'pg_dump')).toBe('backup-tooling');
    expect(classifyPath('infra/gcp/consumer/terraform/runtime.tf', 'database-url')).toBe(
      'terraform',
    );
    expect(classifyPath('.github/workflows/nightly.yml', 'DATABASE_URL: secrets.PROD_DB')).toBe(
      'ci-workflow',
    );
    expect(
      classifyPath(
        '.github/workflows/ci.yml',
        'DATABASE_URL: postgres://assistant:assistant@localhost',
      ),
    ).toBe('tests');
    expect(classifyPath('infra/gcp/workspace-export.sh', 'database-url')).toBe('migration-tooling');
    expect(classifyPath('packages/db/src/client.ts', 'DATABASE_URL')).toBe('application-code');
    expect(classifyPath('packages/db/src/client.test.ts', 'DATABASE_URL')).toBe('tests');
    expect(classifyPath('scripts/retract-messages.ts', 'PROD_DATABASE_URL')).toBe(
      'operator-script',
    );
    expect(classifyPath('docs/recovery.md', 'pg_restore')).toBe('documentation');
    expect(classifyPath('Makefile', 'DATABASE_URL')).toBe('unclassified');
  });

  it('reports each file and line and skips the cutover tooling itself', () => {
    const findings = scanRepository([
      { path: 'infra/gcp/deploy.sh', text: 'a\nmake_secret database-url "$X"\nb\nDATABASE_URL=1' },
      { path: 'scripts/cutover-neon-fence.ts', text: 'DATABASE_URL' },
      { path: 'README.md', text: 'nothing here' },
    ]);
    expect(findings).toEqual([
      { path: 'infra/gcp/deploy.sh', lines: [2, 4], class: 'release-pipeline' },
    ]);
  });
});

describe('retirement evidence report', () => {
  it('is READY only with complete evidence, clean cloud config and repo, archive, and owner decisions', () => {
    const evidence = store();
    writeEvidence(evidence, cleanInventory());
    const report = buildRetirementReport({
      config,
      store: evidence,
      findings: scanRepository(cleanRepo),
      decisions,
      now: new Date('2026-10-02T12:00:00Z'),
      minObservationHours: 168,
    });
    expect(report.checks.filter((check) => !check.ok)).toEqual([]);
    expect(report.ready).toBe(true);
    expect(report.retirementActions.join('\n')).toContain('database-url-final-export');
    expect(report.retirementActions.join('\n')).toContain('br-snapshot');
    const markdown = renderRetirementReport(report);
    expect(markdown).toContain('Verdict: READY');
    expect(markdown).toContain('accepted loss by owner');
    expect(markdown).toContain('### application-code');
  });

  it('lists the five unrecoverable asset references as requiring an owner decision', () => {
    const evidence = store();
    writeEvidence(evidence, cleanInventory());
    const partial = {
      ...decisions,
      acceptedLosses: decisions.acceptedLosses?.slice(0, 3),
    };
    const report = buildRetirementReport({
      config,
      store: evidence,
      findings: [],
      decisions: partial,
      now: new Date('2026-10-02T12:00:00Z'),
      minObservationHours: 168,
    });
    expect(report.ready).toBe(false);
    const check = report.checks.find((item) => item.name.startsWith('Owner accepted-loss'));
    expect(check).toMatchObject({ ok: false, detail: 'missing-4, missing-5' });
    const markdown = renderRetirementReport(report);
    expect(markdown.match(/\*\*required\*\*/g)).toHaveLength(2);
    expect(report.unresolvedAssets).toHaveLength(5);
  });

  it('blocks on remaining Cloud Run, Scheduler, and repository database dependencies', () => {
    const evidence = store();
    const inventory = cleanInventory();
    inventory.jobs.push({
      name: 'assistant-migrate',
      image: 'm',
      envNames: ['DATABASE_URL'],
      secretRefs: [{ env: 'DATABASE_URL', secret: 'database-url', version: 'latest' }],
    });
    inventory.schedulerJobs.push({
      name: 'assistant-legacy',
      state: 'ENABLED',
      schedule: '* * * * *',
      targetHost: 'old-agent.a.run.app',
    });
    writeEvidence(evidence, inventory);
    const report = buildRetirementReport({
      config,
      store: evidence,
      findings: scanRepository([
        ...cleanRepo,
        { path: 'infra/gcp/release.sh', text: '--set-secrets "DATABASE_URL=database-url:latest"' },
        { path: 'infra/docker/backup.sh', text: 'pg_dump --dbname="$DATABASE_URL"' },
      ]),
      decisions,
      now: new Date('2026-10-02T12:00:00Z'),
      minObservationHours: 168,
    });
    const failed = Object.fromEntries(
      report.checks.filter((check) => !check.ok).map((check) => [check.name, check.detail]),
    );
    expect(failed).toEqual({
      'No Cloud Run service or job references DATABASE_URL or a database secret':
        'job assistant-migrate',
      'Every enabled Scheduler job targets a Firestore service': 'assistant-legacy',
      'No release, backup, Terraform, or CI path depends on the database':
        'infra/docker/backup.sh, infra/gcp/release.sh',
    });
    expect(renderRetirementReport(report)).toContain('Verdict: NOT READY');
  });

  it('blocks on incomplete evidence, a short observation window, and a missing archive', () => {
    const evidence = store();
    writeEvidence(evidence, cleanInventory(), { skip: 'live-verify' });
    const report = buildRetirementReport({
      config,
      store: evidence,
      findings: [],
      decisions: { acceptedLosses: decisions.acceptedLosses },
      now: new Date('2026-09-24T13:00:00Z'),
      minObservationHours: 168,
    });
    const failed = report.checks.filter((check) => !check.ok).map((check) => check.name);
    expect(failed).toEqual(
      expect.arrayContaining([
        'All cutover steps passed under this configuration',
        'Firestore production observed for at least 168 hours',
        'No Cloud Run service or job references DATABASE_URL or a database secret',
        'A separately retained PostgreSQL archive has a tested restore',
      ]),
    );
  });

  it('prefers a fresh read-only inventory over the live-verify snapshot', () => {
    const evidence = store();
    writeEvidence(evidence, cleanInventory());
    const fresh = cleanInventory();
    fresh.services.push({
      ...(fresh.services[0] as Inventory['services'][number]),
      name: 'assistant-web-legacy',
      secretRefs: [{ env: 'DATABASE_URL', secret: 'database-url', version: 'latest' }],
    });
    const report = buildRetirementReport({
      config,
      store: evidence,
      findings: [],
      decisions,
      now: new Date('2026-10-02T12:00:00Z'),
      minObservationHours: 168,
      liveInventory: fresh,
    });
    expect(report.inventorySource).toBe('fresh read-only capture');
    expect(report.cloudDependencies.map((item) => item.name)).toEqual(['assistant-web-legacy']);
    expect(report.ready).toBe(false);
  });
});
