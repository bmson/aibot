import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  advanceInstallationStage,
  type InstallationManifest,
  type InstallationStage,
  validateInstallationManifest,
} from './installation-manifest.js';
import { persistInstallationProgress, readPersistedInstallation } from './installation-state.js';
import type { CommandResult, CommandRunner } from './runner.js';

const cloudStages: readonly InstallationStage[] = [
  'authorized',
  'bootstrapped',
  'provisioned',
  'initialized',
  'ready',
];

export interface ConsumerInstallOptions {
  manifest: InstallationManifest;
  archivePath: string;
  statePath: string;
  terraformDir: string;
  stateBucket: string;
  apply: boolean;
  now?: () => string;
}

export interface ConsumerInstallResult {
  manifest: InstallationManifest;
  applied: boolean;
  runtimeReady: false;
  completed: readonly InstallationStage[];
  pending: readonly InstallationStage[];
  note: string;
  disabledApis?: readonly string[];
}

export interface ConsumerInstallDependencies {
  runner: CommandRunner;
  terraform?: CommandRunner;
}

function commandFailed(command: string, result: CommandResult): Error {
  return new Error(`${command} failed: ${result.stderr || result.stdout || 'unknown error'}`);
}

async function runOk(
  runner: CommandRunner,
  command: string,
  args: readonly string[],
): Promise<CommandResult> {
  const result = await runner.run(command, args);
  if (!result.ok) throw commandFailed([command, ...args].join(' '), result);
  return result;
}

function jsonOutput(result: CommandResult, description: string): unknown {
  try {
    return JSON.parse(result.stdout || 'null');
  } catch {
    throw new Error(`${description} returned invalid JSON`);
  }
}

function hasDatabase(databases: unknown, databaseId: string): boolean {
  if (!Array.isArray(databases)) throw new Error('Firestore database list returned malformed JSON');
  return databases.some((entry) => {
    if (!entry || typeof entry !== 'object')
      throw new Error('Firestore database list contains malformed entry');
    const value = entry as Record<string, unknown>;
    const name = typeof value.name === 'string' ? value.name.split('/').at(-1) : undefined;
    if (!name && typeof value.databaseId !== 'string' && typeof value.id !== 'string')
      throw new Error('Firestore database list contains an entry without an identity');
    return name === databaseId || value.databaseId === databaseId || value.id === databaseId;
  });
}

const requiredApis = (provider: InstallationManifest['selection']['modelProvider']): string[] => [
  'artifactregistry.googleapis.com',
  'firestore.googleapis.com',
  'iam.googleapis.com',
  'iamcredentials.googleapis.com',
  'serviceusage.googleapis.com',
  'storage.googleapis.com',
  ...(provider === 'google' ? ['aiplatform.googleapis.com'] : []),
];

async function verifyProjectAndDatabase(
  runner: CommandRunner,
  manifest: InstallationManifest,
  apply: boolean,
): Promise<string[]> {
  const project = manifest.identity.projectId;
  await runOk(runner, 'gcloud', ['projects', 'describe', project, '--format=value(projectId)']);
  const services = await runOk(runner, 'gcloud', [
    'services',
    'list',
    `--project=${project}`,
    '--enabled',
    '--format=json',
  ]);
  const serviceRows = jsonOutput(services, 'Enabled API list');
  if (!Array.isArray(serviceRows)) throw new Error('Enabled API list returned malformed JSON');
  const enabled = new Set(
    serviceRows.flatMap((row) =>
      row &&
      typeof row === 'object' &&
      typeof (row as { config?: { name?: unknown } }).config?.name === 'string'
        ? [(row as { config: { name: string } }).config.name]
        : [],
    ),
  );
  const missing = requiredApis(manifest.selection.modelProvider).filter((api) => !enabled.has(api));
  if (apply && missing.length)
    await runOk(runner, 'gcloud', ['services', 'enable', ...missing, `--project=${project}`]);
  if (!apply && missing.length) return missing;
  const databases = await runOk(runner, 'gcloud', [
    'firestore',
    'databases',
    'list',
    `--project=${project}`,
    '--format=json',
  ]);
  if (hasDatabase(jsonOutput(databases, 'Firestore database list'), manifest.identity.databaseId)) {
    throw new Error(
      `Refusing to adopt existing Firestore database ${manifest.identity.databaseId}`,
    );
  }
  return missing;
}

async function ensureFreshBucket(
  runner: CommandRunner,
  bucket: string,
  project: string,
  region: string,
  installationId: string,
  releaseId: string,
  archiveDigest: string,
): Promise<void> {
  const result = await runner.run('gcloud', [
    'storage',
    'buckets',
    'describe',
    `gs://${bucket}`,
    `--project=${project}`,
    '--format=json',
  ]);
  if (result.ok) {
    const description = jsonOutput(result, 'State bucket description') as Record<
      string,
      unknown
    > | null;
    const projectNumber = await runOk(runner, 'gcloud', [
      'projects',
      'describe',
      project,
      '--format=value(projectNumber)',
    ]);
    if (
      !/^\d+$/.test(projectNumber.stdout) ||
      !description ||
      String(description.project_number) !== projectNumber.stdout ||
      String(description.location).toLowerCase() !== region.toLowerCase() ||
      description.name !== bucket ||
      description.uniform_bucket_level_access !== true ||
      description.public_access_prevention !== 'enforced'
    )
      throw new Error(
        `Refusing to reuse state bucket gs://${bucket}: project, location, or access protection differs`,
      );
    const receipt = await runner.run('gcloud', [
      'storage',
      'objects',
      'describe',
      `gs://${bucket}/releases/${releaseId}.tar.gz`,
      '--format=json',
    ]);
    if (!receipt.ok)
      throw new Error(
        `Refusing to adopt existing customer state bucket gs://${bucket} without an installation receipt`,
      );
    const receiptValue = jsonOutput(receipt, 'Installation receipt');
    const metadata =
      receiptValue && typeof receiptValue === 'object' && 'metadata' in receiptValue
        ? (receiptValue as { metadata?: unknown }).metadata
        : undefined;
    if (
      !metadata ||
      typeof metadata !== 'object' ||
      (metadata as Record<string, unknown>).assistant_installation !== installationId ||
      (metadata as Record<string, unknown>).assistant_archive_digest !== archiveDigest
    ) {
      throw new Error(`Refusing to adopt existing customer state bucket gs://${bucket}`);
    }
    return;
  }
  if (!/(not.?found|404|does not exist)/i.test(result.stderr)) {
    throw commandFailed(`gcloud storage buckets describe gs://${bucket}`, result);
  }
  await runOk(runner, 'gcloud', [
    'storage',
    'buckets',
    'create',
    `gs://${bucket}`,
    `--project=${project}`,
    `--location=${region}`,
    '--uniform-bucket-level-access',
    '--public-access-prevention',
  ]);
}

async function terraform(
  runner: CommandRunner,
  options: ConsumerInstallOptions,
  args: readonly string[],
): Promise<CommandResult> {
  return runOk(runner, 'terraform', [`-chdir=${options.terraformDir}`, ...args]);
}

async function verifyTerraformDirectory(terraformDir: string): Promise<void> {
  const expected = resolve(process.cwd(), 'infra/gcp/consumer/terraform');
  if (resolve(terraformDir) !== expected) {
    throw new Error(`Terraform directory must be the verified consumer foundation: ${expected}`);
  }
  await Promise.all(
    ['main.tf', 'variables.tf', 'outputs.tf', 'versions.tf'].map((file) =>
      access(resolve(terraformDir, file)),
    ),
  );
}

const foundationFiles = [
  'main.tf',
  'variables.tf',
  'outputs.tf',
  'versions.tf',
  '.terraform.lock.hcl',
] as const;

function tarString(header: Buffer, start: number, length: number): string {
  return header
    .subarray(start, start + length)
    .toString('utf8')
    .replace(/\0.*$/, '');
}

function tarOctal(header: Buffer, start: number, length: number): number {
  const value = tarString(header, start, length).trim();
  const parsed = Number.parseInt(value || '0', 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error('Installation archive has an invalid tar size');
  return parsed;
}

async function verifyTrustedFoundationArchive(
  archivePath: string,
  terraformDir: string,
  expectedDigest: string,
): Promise<Map<string, Buffer>> {
  const archiveStat = await stat(archivePath);
  if (!archiveStat.isFile()) throw new Error('Installation archive must be a regular file');
  if (archiveStat.size > 128 * 1024 * 1024)
    throw new Error('Installation archive exceeds the 128 MiB limit');
  const compressed = await readFile(archivePath);
  const actualDigest = `sha256:${createHash('sha256').update(compressed).digest('hex')}`;
  if (actualDigest.toLowerCase() !== expectedDigest.toLowerCase()) {
    throw new Error(
      `Installation archive digest mismatch: expected ${expectedDigest.toLowerCase()}, got ${actualDigest}`,
    );
  }
  if (compressed.length > 128 * 1024 * 1024)
    throw new Error('Installation archive exceeds the 128 MiB limit');
  const tar =
    compressed[0] === 0x1f && compressed[1] === 0x8b
      ? gunzipSync(compressed, { maxOutputLength: 128 * 1024 * 1024 })
      : compressed;
  if (tar.length > 128 * 1024 * 1024)
    throw new Error('Installation archive exceeds the 128 MiB limit');
  const entries = new Map<string, Buffer>();
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    if (!path || path.startsWith('/') || path.split('/').includes('..'))
      throw new Error('Installation archive contains an unsafe path');
    const type = header[156];
    const regular = type === 0 || type === 48;
    const directory = type === 5 || type === 53;
    if (type === 1 || type === 2 || (!regular && !directory && type !== 103 && type !== 120))
      throw new Error(`Installation archive contains unsupported entry ${path}`);
    const size = tarOctal(header, 124, 12);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new Error('Installation archive contains a truncated entry');
    const checksumText = tarString(header, 148, 8).trim();
    const expectedChecksum = Number.parseInt(checksumText, 8);
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
    if (!Number.isSafeInteger(expectedChecksum) || actualChecksum !== expectedChecksum)
      throw new Error(`Installation archive has an invalid tar checksum for ${path}`);
    if (type === 103 || type === 120) {
      const pax = tar.subarray(dataStart, dataEnd).toString('utf8');
      if (/\b(?:path|linkpath)=/.test(pax))
        throw new Error('Installation archive uses a PAX path override');
    }
    if (entries.has(path)) throw new Error(`Installation archive contains duplicate entry ${path}`);
    if (regular) entries.set(path, Buffer.from(tar.subarray(dataStart, dataEnd)));
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  for (const file of foundationFiles) {
    const archiveEntry = entries.get(`infra/gcp/consumer/terraform/${file}`);
    if (!archiveEntry)
      throw new Error(`Installation archive is missing infra/gcp/consumer/terraform/${file}`);
    const trusted = await readFile(resolve(terraformDir, file));
    if (!archiveEntry.equals(trusted))
      throw new Error(`Installation archive foundation mismatch for ${file}`);
  }
  return entries;
}

async function prepareTerraformWorkspace(verified: Map<string, Buffer>): Promise<string> {
  const isolated = await mkdtemp(join(tmpdir(), 'assistant-consumer-terraform-'));
  for (const file of foundationFiles) {
    const content = verified.get(`infra/gcp/consumer/terraform/${file}`);
    if (!content) throw new Error(`Verified Terraform file is missing ${file}`);
    await writeFile(join(isolated, file), content, { mode: 0o600 });
  }
  return isolated;
}

function validateTerraformOutputs(
  raw: unknown,
  manifest: InstallationManifest,
): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Terraform output was not a JSON object');
  const output = raw as Record<string, unknown>;
  const outputValue = (key: string): unknown => {
    const entry = output[key];
    if (!entry || typeof entry !== 'object' || !('value' in entry))
      throw new Error(`Terraform output missing ${key}`);
    return (entry as { value: unknown }).value;
  };
  if (outputValue('project_id') !== manifest.identity.projectId)
    throw new Error('Terraform output project does not match manifest');
  if (outputValue('installation_id') !== manifest.identity.installationId)
    throw new Error('Terraform output installation does not match manifest');
  if (outputValue('region') !== manifest.identity.region)
    throw new Error('Terraform output region does not match manifest');
  if (outputValue('firestore_database_name') !== manifest.identity.databaseId)
    throw new Error('Terraform output database does not match manifest');
  const project = manifest.identity.projectId;
  const installation = manifest.identity.installationId;
  if (outputValue('assets_bucket_name') !== `${project}-${installation}-assets`)
    throw new Error('Terraform output assets bucket does not match manifest');
  if (outputValue('source_bucket_name') !== `${project}-${installation}-source`)
    throw new Error('Terraform output source bucket does not match manifest');
  if (
    outputValue('artifact_registry_repository') !==
    `projects/${project}/locations/${manifest.identity.region}/repositories/${installation}`
  )
    throw new Error('Terraform output Artifact Registry does not match manifest');
  if (
    outputValue('runtime_service_account_email') !==
    `${installation}-runtime@${project}.iam.gserviceaccount.com`
  )
    throw new Error('Terraform output runtime identity does not match manifest');
  return output;
}

function foundationResources(output: Record<string, unknown>, manifest: InstallationManifest) {
  const outputValue = (key: string) => (output[key] as { value: string }).value;
  const id = manifest.identity.installationId;
  const owned = (kind: string, name: string, scope: 'installation' | 'project') => ({
    kind,
    name,
    scope,
    owner: 'terraform' as const,
    installationId: id,
  });
  return [
    owned('firestore-database', outputValue('firestore_database_name'), 'project'),
    owned('assets-bucket', outputValue('assets_bucket_name'), 'installation'),
    owned('source-bucket', outputValue('source_bucket_name'), 'installation'),
    owned('artifact-registry', outputValue('artifact_registry_repository'), 'installation'),
    owned('runtime-service-account', outputValue('runtime_service_account_email'), 'installation'),
  ];
}

function terraformVars(
  manifest: InstallationManifest,
  stateBucket: string,
  includeBackend = false,
): string[] {
  const project = manifest.identity.projectId;
  const install = manifest.identity.installationId;
  const vars = [
    '-var',
    `project_id=${project}`,
    '-var',
    `region=${manifest.identity.region}`,
    '-var',
    `installation_id=${install}`,
    '-var',
    `firestore_database_id=${manifest.identity.databaseId}`,
    '-var',
    `create_default_database=${manifest.identity.databaseId === '(default)'}`,
    '-var',
    `firestore_location_id=${manifest.identity.region}`,
    '-var',
    `assets_bucket_name=${project}-${install}-assets`,
    '-var',
    `source_bucket_name=${project}-${install}-source`,
    '-var',
    `artifact_repository_id=${install}`,
  ];
  return includeBackend
    ? [
        ...vars,
        '-backend-config',
        `bucket=${stateBucket}`,
        '-backend-config',
        `prefix=assistant/${install}`,
      ]
    : vars;
}

/** Provision the customer-owned foundation in resumable, verified stages. */
export async function provisionConsumerInstallation(
  dependencies: ConsumerInstallDependencies,
  options: ConsumerInstallOptions,
): Promise<ConsumerInstallResult> {
  const input = validateInstallationManifest(options.manifest);
  if (input.status !== 'active') throw new Error('Cannot provision an invalidated installation');
  const now = options.now ?? (() => new Date().toISOString());
  const terraformRunner = dependencies.terraform ?? dependencies.runner;
  await verifyTerraformDirectory(options.terraformDir);
  // Complete archive verification before any cloud read or write. The returned
  // buffers are the only Terraform inputs used later, preventing unverified
  // files in the checkout (or a second read) from entering the apply.
  const verifiedFoundation = await verifyTrustedFoundationArchive(
    options.archivePath,
    options.terraformDir,
    input.identity.release.archiveDigest,
  );
  const expectedStateBucket = `${input.identity.projectId}-${input.identity.installationId}-state`;
  if (options.stateBucket !== expectedStateBucket)
    throw new Error(`State bucket must be ${expectedStateBucket} for this installation`);

  const persisted = await readPersistedInstallation(options.statePath);
  if (!persisted && input.stage.current !== 'previewed')
    throw new Error('An advanced manifest requires matching persisted installation state');
  let current = persisted ?? input;
  if (current.status !== 'active') throw new Error('Cannot resume an invalidated installation');
  if (persisted && JSON.stringify(persisted.identity) !== JSON.stringify(input.identity)) {
    throw new Error('Persisted installation identity does not match the supplied manifest');
  }
  if (persisted && JSON.stringify(persisted.selection) !== JSON.stringify(input.selection)) {
    throw new Error('Persisted installation selection does not match the supplied manifest');
  }
  if (current.stage.current === 'previewed' || current.stage.current === 'authorized') {
    const missingApis = await verifyProjectAndDatabase(dependencies.runner, current, options.apply);
    if (!options.apply) {
      return {
        manifest: current,
        applied: false,
        runtimeReady: false,
        completed: current.stage.completed,
        pending: cloudStages.filter((stage) => !current.stage.completed.includes(stage)),
        disabledApis: missingApis,
        note: missingApis.length
          ? `Validated archive and project. Required APIs are disabled: ${missingApis.join(', ')}. No resources were changed.`
          : 'Validated archive, project, and database absence. No resources were changed; pass --apply to provision the foundation.',
      };
    }
  } else {
    await runOk(dependencies.runner, 'gcloud', [
      'projects',
      'describe',
      current.identity.projectId,
      '--format=value(projectId)',
    ]);
  }
  if (!options.apply) {
    return {
      manifest: current,
      applied: false,
      runtimeReady: false,
      completed: current.stage.completed,
      pending: cloudStages.filter(
        (stage) => !current.stage.completed.includes(stage as InstallationStage),
      ),
      note: 'Validated archive and project for the persisted foundation stage. No resources were changed.',
    };
  }

  if (current.stage.current === 'previewed') {
    const previous = current;
    current = advanceInstallationStage(previous, 'authorized', now());
    await persistInstallationProgress(options.statePath, current, persisted ?? null);
  }
  if (current.stage.current === 'authorized') {
    await ensureFreshBucket(
      dependencies.runner,
      options.stateBucket,
      current.identity.projectId,
      current.identity.region,
      current.identity.installationId,
      current.identity.release.commitSha,
      current.identity.release.archiveDigest,
    );
    await runOk(dependencies.runner, 'gcloud', [
      'storage',
      'cp',
      options.archivePath,
      `gs://${options.stateBucket}/releases/${current.identity.release.commitSha}.tar.gz`,
      `--custom-metadata=assistant_installation=${current.identity.installationId},assistant_archive_digest=${current.identity.release.archiveDigest}`,
    ]);
    const previous = current;
    current = validateInstallationManifest({
      ...advanceInstallationStage(previous, 'bootstrapped', now()),
      resources: [
        ...previous.resources,
        {
          kind: 'state-bucket',
          name: options.stateBucket,
          scope: 'installation',
          owner: 'bootstrap',
          installationId: current.identity.installationId,
        },
        {
          kind: 'release-receipt',
          name: `gs://${options.stateBucket}/releases/${current.identity.release.commitSha}.tar.gz`,
          scope: 'installation',
          owner: 'bootstrap',
          installationId: current.identity.installationId,
        },
      ],
    });
    await persistInstallationProgress(options.statePath, current, previous);
  }
  if (current.stage.current === 'bootstrapped') {
    const executableTerraformDir = await prepareTerraformWorkspace(verifiedFoundation);
    const terraformOptions = { ...options, terraformDir: executableTerraformDir };
    await terraform(terraformRunner, terraformOptions, [
      'init',
      '-backend-config',
      `bucket=${options.stateBucket}`,
      '-backend-config',
      `prefix=assistant/${current.identity.installationId}`,
    ]);
    await terraform(terraformRunner, terraformOptions, [
      'apply',
      '-auto-approve',
      ...terraformVars(current, options.stateBucket),
    ]);
    const output = await terraform(terraformRunner, terraformOptions, ['output', '-json']);
    const outputValues = validateTerraformOutputs(jsonOutput(output, 'Terraform output'), current);
    await rm(executableTerraformDir, { recursive: true, force: true });
    const previous = current;
    current = validateInstallationManifest({
      ...advanceInstallationStage(previous, 'provisioned', now()),
      resources: [...current.resources, ...foundationResources(outputValues, current)],
    });
    await persistInstallationProgress(options.statePath, current, previous);
  }
  return {
    manifest: current,
    applied: true,
    runtimeReady: false,
    completed: current.stage.completed,
    pending: ['initialized', 'ready'],
    note: 'Customer-owned foundation provisioned. Indexes, runtime services, owner authentication, and readiness verification remain gated.',
  };
}
