import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { verifyConsumerIndexReadiness } from './consumer-index-readiness.js';
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
  runtime?: { images: unknown; config: unknown };
  /** Exact Google OAuth redirect URI confirmed in the customer's Web client. */
  ownerAccessCallback?: string;
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
  ownerAccess?: { webUrl: string; authOrigin: string; callback: string; publicInvoker: boolean };
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
  await Promise.all(verifiedFoundationFiles.map((file) => access(resolve(process.cwd(), file))));
}

const verifiedFoundationFiles = [
  'infra/gcp/consumer/terraform/main.tf',
  'infra/gcp/consumer/terraform/variables.tf',
  'infra/gcp/consumer/terraform/outputs.tf',
  'infra/gcp/consumer/terraform/versions.tf',
  'infra/gcp/consumer/terraform/.terraform.lock.hcl',
  'infra/gcp/consumer/terraform/firestore-indexes.tf',
  'infra/gcp/firestore/firestore.indexes.json',
] as const;
const runtimeFile = 'infra/gcp/consumer/terraform/runtime.tf';
const indexSpecPath = 'infra/gcp/firestore/firestore.indexes.json';

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
  expectedDigest: string,
  includeRuntime = false,
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
  for (const file of includeRuntime
    ? [...verifiedFoundationFiles, runtimeFile]
    : verifiedFoundationFiles) {
    const archiveEntry = entries.get(file);
    if (!archiveEntry) throw new Error(`Installation archive is missing ${file}`);
    const trusted = await readFile(resolve(process.cwd(), file));
    if (!archiveEntry.equals(trusted))
      throw new Error(`Installation archive foundation mismatch for ${file}`);
  }
  return entries;
}

async function prepareTerraformWorkspace(
  verified: Map<string, Buffer>,
  includeRuntime = false,
): Promise<{ root: string; terraformDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'assistant-consumer-terraform-'));
  for (const file of includeRuntime
    ? [...verifiedFoundationFiles, runtimeFile]
    : verifiedFoundationFiles) {
    const content = verified.get(file);
    if (!content) throw new Error(`Verified Terraform file is missing ${file}`);
    const destination = join(root, file);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content, { mode: 0o600 });
  }
  return { root, terraformDir: join(root, 'infra/gcp/consumer/terraform') };
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

type RuntimeInput = {
  webDigest: string;
  agentDigest: string;
  config: {
    firestoreAgentId: string;
    firestoreEmbeddingSpace: {
      provider: string;
      model: string;
      dimensions: number;
      revision: string;
    };
    ownerEmail: string;
    webAuthUrl: string;
    authSecretVersion: number;
    googleClientIdVersion: number;
    googleClientSecretVersion: number;
    mobileApiTokenVersion?: number;
  };
  fingerprint: string;
};

function record(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be a JSON object`);
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some((key) => !keys.includes(key)))
    throw new Error(`${label} contains an unsupported field`);
  return data;
}

function validateRuntimeInput(
  raw: NonNullable<ConsumerInstallOptions['runtime']>,
  manifest: InstallationManifest,
): RuntimeInput {
  if (manifest.identity.databaseId !== '(default)')
    throw new Error('Runtime requires the (default) Firestore database');
  if (manifest.selection.modelProvider !== 'google')
    throw new Error('Runtime requires the Google model provider');
  const images = record(raw.images, 'Image manifest', [
    'schemaVersion',
    'sourceSha',
    'sourceArchiveDigest',
    'projectId',
    'region',
    'repositoryId',
    'tags',
    'images',
    'terraform',
  ]);
  const project = manifest.identity.projectId;
  const region = manifest.identity.region;
  const id = manifest.identity.installationId;
  if (
    images.schemaVersion !== 1 ||
    images.sourceSha !== manifest.identity.release.commitSha ||
    typeof images.sourceArchiveDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(images.sourceArchiveDigest) ||
    images.projectId !== project ||
    images.region !== region ||
    images.repositoryId !== id
  )
    throw new Error(
      'Image manifest does not match this installation release and customer repository',
    );
  const refs = record(images.images, 'Image references', ['web', 'agent']);
  const tags = record(images.tags, 'Image tags', ['web', 'agent']);
  const tf = record(images.terraform, 'Image Terraform inputs', [
    'web_image_digest',
    'agent_image_digest',
  ]);
  const root = `${region}-docker.pkg.dev/${project}/${id}`;
  const digests = ['web', 'agent'].map((name) => {
    const image = record(refs[name], `${name} image`, ['digest', 'reference', 'tag']);
    const digest = image.digest;
    if (
      typeof digest !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(digest) ||
      image.reference !== `${root}/${name}@${digest}` ||
      image.tag !== `${root}/${name}:${images.sourceSha}` ||
      tags[name] !== image.tag ||
      tf[`${name}_image_digest`] !== digest
    )
      throw new Error(
        `${name} image must use the matching customer repository and immutable digest`,
      );
    return digest;
  });
  const config = record(raw.config, 'Runtime config', [
    'firestoreAgentId',
    'firestoreEmbeddingSpace',
    'ownerEmail',
    'webAuthUrl',
    'authSecretVersion',
    'googleClientIdVersion',
    'googleClientSecretVersion',
    'mobileApiTokenVersion',
  ]);
  const space = record(config.firestoreEmbeddingSpace, 'Embedding space', [
    'provider',
    'model',
    'dimensions',
    'revision',
  ]);
  if (
    typeof config.firestoreAgentId !== 'string' ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(config.firestoreAgentId)
  )
    throw new Error('Runtime config requires a seeded Firestore agent UUID');
  if (
    space.provider !== 'vertex' ||
    typeof space.model !== 'string' ||
    !space.model ||
    !Number.isInteger(space.dimensions) ||
    (space.dimensions as number) < 1 ||
    (space.dimensions as number) > 2048 ||
    typeof space.revision !== 'string' ||
    !space.revision
  )
    throw new Error('Runtime config requires explicit Vertex embedding provenance');
  if (
    typeof config.ownerEmail !== 'string' ||
    !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(config.ownerEmail) ||
    typeof config.webAuthUrl !== 'string' ||
    !/^https:\/\/[A-Za-z0-9.-]+(?::443)?$/.test(config.webAuthUrl)
  )
    throw new Error('Runtime config requires an owner email and HTTPS OAuth origin');
  for (const key of ['authSecretVersion', 'googleClientIdVersion', 'googleClientSecretVersion']) {
    if (!Number.isSafeInteger(config[key]) || (config[key] as number) < 1)
      throw new Error(`Runtime config requires a positive numbered ${key}`);
  }
  if (
    config.mobileApiTokenVersion !== undefined &&
    (!Number.isSafeInteger(config.mobileApiTokenVersion) ||
      (config.mobileApiTokenVersion as number) < 1)
  )
    throw new Error('Runtime config requires a positive numbered mobileApiTokenVersion');
  const [webDigest, agentDigest] = digests;
  if (!webDigest || !agentDigest) throw new Error('Image manifest requires web and agent images');
  const normalized = { webDigest, agentDigest, config: config as RuntimeInput['config'] };
  return {
    ...normalized,
    fingerprint: `sha256:${createHash('sha256').update(JSON.stringify(normalized)).digest('hex')}`,
  };
}

async function runRuntimeCheck(
  runner: CommandRunner,
  args: readonly string[],
  label: string,
): Promise<CommandResult> {
  const result = await runner.run('gcloud', args);
  // Cloud command diagnostics can contain headers or environment values. Keep
  // customer credentials and secret payloads out of installer output.
  if (!result.ok)
    throw new Error(`${label} failed; check customer project access and resource prerequisites`);
  return result;
}

async function verifyRuntimePrerequisites(
  runner: CommandRunner,
  manifest: InstallationManifest,
  input: RuntimeInput,
): Promise<void> {
  const project = manifest.identity.projectId;
  const region = manifest.identity.region;
  const id = manifest.identity.installationId;
  for (const [name, digest] of [
    ['web', input.webDigest],
    ['agent', input.agentDigest],
  ]) {
    await runRuntimeCheck(
      runner,
      [
        'artifacts',
        'docker',
        'images',
        'describe',
        `${region}-docker.pkg.dev/${project}/${id}/${name}@${digest}`,
        `--project=${project}`,
        '--format=json',
      ],
      `${name} image lookup`,
    );
  }
  for (const [suffix, version] of [
    ['auth-secret', input.config.authSecretVersion],
    ['google-client-id', input.config.googleClientIdVersion],
    ['google-client-secret', input.config.googleClientSecretVersion],
    ...(input.config.mobileApiTokenVersion === undefined
      ? []
      : ([['mobile-api-token', input.config.mobileApiTokenVersion]] as const)),
  ] as const) {
    const result = await runRuntimeCheck(
      runner,
      [
        'secrets',
        'versions',
        'describe',
        String(version),
        `--secret=${id}-${suffix}`,
        `--project=${project}`,
        '--format=json',
      ],
      `${suffix} secret version lookup`,
    );
    const data = jsonOutput(result, 'Secret version metadata') as { state?: unknown };
    if (data?.state !== 'ENABLED') throw new Error(`${suffix} secret version must be enabled`);
  }
}

function runtimeVars(input: RuntimeInput): string[] {
  const vars: Record<string, string> = {
    web_image_digest: input.webDigest,
    agent_image_digest: input.agentDigest,
    firestore_agent_id: input.config.firestoreAgentId,
    firestore_embedding_space: JSON.stringify(input.config.firestoreEmbeddingSpace),
    owner_email: input.config.ownerEmail,
    web_auth_url: input.config.webAuthUrl,
    auth_secret_version: String(input.config.authSecretVersion),
    google_client_id_version: String(input.config.googleClientIdVersion),
    google_client_secret_version: String(input.config.googleClientSecretVersion),
  };
  if (input.config.mobileApiTokenVersion !== undefined)
    vars.mobile_api_token_version = String(input.config.mobileApiTokenVersion);
  return Object.entries(vars).flatMap(([key, value]) => ['-var', `${key}=${value}`]);
}

async function verifyRuntimeServices(
  runner: CommandRunner,
  manifest: InstallationManifest,
  input: RuntimeInput,
): Promise<void> {
  const { projectId: project, region, installationId: id } = manifest.identity;
  for (const [name, digest] of [
    ['web', input.webDigest],
    ['agent', input.agentDigest],
  ]) {
    const result = await runRuntimeCheck(
      runner,
      [
        'run',
        'services',
        'describe',
        `${id}-${name}`,
        `--project=${project}`,
        `--region=${region}`,
        '--format=json',
      ],
      `${name} Cloud Run smoke check`,
    );
    const service = jsonOutput(result, 'Cloud Run service') as Record<string, unknown>;
    const metadata = service?.metadata as { name?: unknown } | undefined;
    const spec = service?.spec as
      | { template?: { spec?: { containers?: Array<{ image?: unknown }> } } }
      | undefined;
    const status = service?.status as
      | {
          conditions?: Array<{ type?: unknown; state?: unknown; status?: unknown }>;
          latestReadyRevisionName?: unknown;
          latestCreatedRevisionName?: unknown;
        }
      | undefined;
    const template = service?.template as { containers?: Array<{ image?: unknown }> } | undefined;
    const conditions = (service?.conditions ?? status?.conditions) as
      | Array<{ type?: unknown; state?: unknown; status?: unknown }>
      | undefined;
    const image = `${region}-docker.pkg.dev/${project}/${id}/${name}@${digest}`;
    const deployedImage =
      template?.containers?.[0]?.image ?? spec?.template?.spec?.containers?.[0]?.image;
    const readyRevision = service?.latestReadyRevision ?? status?.latestReadyRevisionName;
    const createdRevision = service?.latestCreatedRevision ?? status?.latestCreatedRevisionName;
    if (
      (service?.name ?? metadata?.name) !== `${id}-${name}` ||
      deployedImage !== image ||
      !Array.isArray(conditions) ||
      !conditions.some(
        (condition) =>
          condition.type === 'Ready' &&
          (condition.state === 'CONDITION_SUCCEEDED' || condition.status === 'True'),
      ) ||
      typeof readyRevision !== 'string' ||
      !readyRevision ||
      readyRevision !== createdRevision
    )
      throw new Error(
        `${name} Cloud Run service is not serving the expected ready digest revision`,
      );
  }
}

async function inspectOwnerAccess(
  runner: CommandRunner,
  manifest: InstallationManifest,
  input: RuntimeInput,
  expectedPublic: boolean,
): Promise<NonNullable<ConsumerInstallResult['ownerAccess']>> {
  const { projectId, region, installationId } = manifest.identity;
  const serviceFor = async (name: 'web' | 'agent') =>
    jsonOutput(
      await runRuntimeCheck(
        runner,
        [
          'run',
          'services',
          'describe',
          `${installationId}-${name}`,
          `--project=${projectId}`,
          `--region=${region}`,
          '--format=json',
        ],
        `${name} service lookup`,
      ),
      `${name} service`,
    ) as Record<string, unknown>;
  const [web, agent] = await Promise.all([serviceFor('web'), serviceFor('agent')]);
  const iamDisabled = (service: Record<string, unknown>) =>
    service.invokerIamDisabled === true ||
    (service.metadata as { annotations?: Record<string, unknown> } | undefined)?.annotations?.[
      'run.googleapis.com/invoker-iam-disabled'
    ] === 'true';
  const url = web.uri ?? (web.status as { url?: unknown } | undefined)?.url;
  const container =
    (
      web.template as
        | { containers?: Array<{ env?: Array<{ name?: string; value?: string }> }> }
        | undefined
    )?.containers?.[0] ??
    (
      web.spec as
        | {
            template?: {
              spec?: {
                containers?: Array<{ env?: Array<{ name?: string; value?: string }> }>;
              };
            };
          }
        | undefined
    )?.template?.spec?.containers?.[0];
  const env = new Map(container?.env?.map(({ name, value }) => [name, value]) ?? []);
  if (
    typeof url !== 'string' ||
    !/^https:\/\/[A-Za-z0-9.-]+(?::443)?$/.test(url) ||
    iamDisabled(web) ||
    iamDisabled(agent) ||
    env.get('OWNER_EMAIL') !== input.config.ownerEmail ||
    env.get('AUTH_URL') !== input.config.webAuthUrl ||
    env.get('AUTH_DEV_BYPASS') !== 'false' ||
    env.get('AUTH_LOCALHOST_BYPASS') !== 'false'
  )
    throw new Error(
      'Web service URL, owner auth, or Cloud Run IAM configuration differs from the runtime checkpoint',
    );
  const policyFor = async (name: 'web' | 'agent') => {
    const value = jsonOutput(
      await runRuntimeCheck(
        runner,
        [
          'run',
          'services',
          'get-iam-policy',
          `${installationId}-${name}`,
          `--project=${projectId}`,
          `--region=${region}`,
          '--format=json',
        ],
        `${name} IAM policy lookup`,
      ),
      `${name} IAM policy`,
    ) as { bindings?: Array<{ role?: string; members?: string[] }> };
    if (value.bindings !== undefined && !Array.isArray(value.bindings))
      throw new Error(`${name} IAM policy is malformed`);
    const invokers =
      value.bindings?.filter((binding) => binding.role === 'roles/run.invoker') ?? [];
    return {
      allUsers: invokers.some((binding) => binding.members?.includes('allUsers')),
      broad: invokers.some((binding) =>
        binding.members?.some(
          (member) => member === 'allUsers' || member === 'allAuthenticatedUsers',
        ),
      ),
    };
  };
  const [webPolicy, agentPolicy] = await Promise.all([policyFor('web'), policyFor('agent')]);
  if (agentPolicy.broad)
    throw new Error('Agent service has a public invoker binding; refusing owner access');
  if (expectedPublic && !webPolicy.allUsers)
    throw new Error('Web public invoker binding was not verified');
  return {
    webUrl: url,
    authOrigin: input.config.webAuthUrl,
    callback: `${input.config.webAuthUrl}/api/auth/callback/google`,
    publicInvoker: webPolicy.allUsers,
  };
}

/** Provision the customer-owned foundation in resumable, verified stages. */
export async function provisionConsumerInstallation(
  dependencies: ConsumerInstallDependencies,
  options: ConsumerInstallOptions,
): Promise<ConsumerInstallResult> {
  const input = validateInstallationManifest(options.manifest);
  if (input.status !== 'active') throw new Error('Cannot provision an invalidated installation');
  const runtime = options.runtime ? validateRuntimeInput(options.runtime, input) : null;
  if (options.ownerAccessCallback && !runtime)
    throw new Error('Owner access requires the matching runtime images and config');
  if (
    options.ownerAccessCallback &&
    options.ownerAccessCallback !== `${runtime?.config.webAuthUrl}/api/auth/callback/google`
  )
    throw new Error('Confirmed OAuth callback must exactly match the configured AUTH_URL callback');
  const now = options.now ?? (() => new Date().toISOString());
  const terraformRunner = dependencies.terraform ?? dependencies.runner;
  await verifyTerraformDirectory(options.terraformDir);
  // Complete archive verification before any cloud read or write. The returned
  // buffers are the only Terraform inputs used later, preventing unverified
  // files in the checkout (or a second read) from entering the apply.
  const verifiedFoundation = await verifyTrustedFoundationArchive(
    options.archivePath,
    input.identity.release.archiveDigest,
    runtime !== null,
  );
  const trustedIndexSpec = verifiedFoundation.get(indexSpecPath);
  if (!trustedIndexSpec) throw new Error('Verified Firestore index specification is missing');
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
  if (current.stage.current === 'initialized' && !runtime)
    throw new Error(
      'An initialized runtime requires the same image manifest and runtime config to resume',
    );
  if (
    runtime &&
    current.stage.current === 'initialized' &&
    !current.resources.some(
      (resource) => resource.kind === 'runtime-config' && resource.name === runtime.fingerprint,
    )
  )
    throw new Error('Runtime config differs from the initialized checkpoint');
  if (options.ownerAccessCallback && current.stage.current !== 'initialized')
    throw new Error('Deploy and verify the private runtime before enabling owner access');
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
    if (current.stage.current === 'provisioned')
      await verifyConsumerIndexReadiness(dependencies.runner, current.identity, trustedIndexSpec);
    let ownerAccess: ConsumerInstallResult['ownerAccess'];
    if (runtime && current.stage.current === 'initialized' && options.ownerAccessCallback) {
      await verifyRuntimePrerequisites(dependencies.runner, current, runtime);
      await verifyRuntimeServices(dependencies.runner, current, runtime);
      ownerAccess = await inspectOwnerAccess(dependencies.runner, current, runtime, false);
    }
    return {
      manifest: current,
      applied: false,
      runtimeReady: false,
      completed: current.stage.completed,
      pending: cloudStages.filter(
        (stage) => !current.stage.completed.includes(stage as InstallationStage),
      ),
      ownerAccess,
      note: ownerAccess
        ? 'Verified private runtime, enabled auth secret versions, web URL, owner auth environment, and service IAM. No resources were changed. Confirm the Google OAuth Web client and HTTPS routing before --apply.'
        : 'Validated archive and project for the persisted foundation stage. No resources were changed.',
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
    const workspace = await prepareTerraformWorkspace(verifiedFoundation);
    const terraformOptions = { ...options, terraformDir: workspace.terraformDir };
    await terraform(terraformRunner, terraformOptions, [
      'init',
      '-input=false',
      '-lockfile=readonly',
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
    await verifyConsumerIndexReadiness(dependencies.runner, current.identity, trustedIndexSpec);
    await rm(workspace.root, { recursive: true, force: true });
    const previous = current;
    current = validateInstallationManifest({
      ...advanceInstallationStage(previous, 'provisioned', now()),
      resources: [...current.resources, ...foundationResources(outputValues, current)],
    });
    await persistInstallationProgress(options.statePath, current, previous);
  } else if (current.stage.current === 'provisioned' || current.stage.current === 'initialized') {
    // Older provisioned manifests did not attest live index readiness. Recheck
    // on resume, and also detect an index removed after an earlier successful run.
    await verifyConsumerIndexReadiness(dependencies.runner, current.identity, trustedIndexSpec);
  }
  if (runtime && current.stage.current === 'provisioned') {
    await verifyRuntimePrerequisites(dependencies.runner, current, runtime);
    const workspace = await prepareTerraformWorkspace(verifiedFoundation, true);
    const terraformOptions = { ...options, terraformDir: workspace.terraformDir };
    const initialized = await terraformRunner.run('terraform', [
      `-chdir=${workspace.terraformDir}`,
      'init',
      '-input=false',
      '-lockfile=readonly',
      '-backend-config',
      `bucket=${options.stateBucket}`,
      '-backend-config',
      `prefix=assistant/${current.identity.installationId}`,
    ]);
    if (!initialized.ok)
      throw new Error('Runtime Terraform init failed; check state bucket access and retry');
    const applied = await terraformRunner.run('terraform', [
      `-chdir=${workspace.terraformDir}`,
      'apply',
      '-input=false',
      '-auto-approve',
      ...terraformVars(current, options.stateBucket),
      ...runtimeVars(runtime),
    ]);
    if (!applied.ok)
      throw new Error(
        'Runtime Terraform apply failed; review the retained work directory and retry the same inputs',
      );
    const output = await terraformRunner.run('terraform', [
      `-chdir=${terraformOptions.terraformDir}`,
      'output',
      '-json',
    ]);
    if (!output.ok)
      throw new Error('Runtime Terraform output failed; check retained work directory and retry');
    const values = validateTerraformOutputs(jsonOutput(output, 'Terraform output'), current);
    const expectedNames = {
      cloud_run_web_service_name: `${current.identity.installationId}-web`,
      cloud_run_agent_service_name: `${current.identity.installationId}-agent`,
    };
    for (const [key, name] of Object.entries(expectedNames)) {
      if ((values[key] as { value?: unknown } | undefined)?.value !== name)
        throw new Error(`Runtime Terraform output ${key} does not match installation`);
    }
    await verifyRuntimeServices(dependencies.runner, current, runtime);
    await rm(workspace.root, { recursive: true, force: true });
    const previous = current;
    current = validateInstallationManifest({
      ...advanceInstallationStage(previous, 'initialized', now()),
      resources: [
        ...previous.resources,
        {
          kind: 'runtime-config',
          name: runtime.fingerprint,
          scope: 'installation',
          owner: 'terraform',
          installationId: current.identity.installationId,
        },
        ...(['web', 'agent'] as const).map((name) => ({
          kind: 'cloud-run-service',
          name: `${current.identity.installationId}-${name}`,
          scope: 'installation' as const,
          owner: 'terraform' as const,
          installationId: current.identity.installationId,
        })),
      ],
    });
    await persistInstallationProgress(options.statePath, current, previous);
  } else if (runtime && current.stage.current === 'initialized') {
    await verifyRuntimeServices(dependencies.runner, current, runtime);
  }
  let ownerAccess: ConsumerInstallResult['ownerAccess'];
  if (runtime && options.ownerAccessCallback && current.stage.current === 'initialized') {
    await verifyRuntimePrerequisites(dependencies.runner, current, runtime);
    const before = await inspectOwnerAccess(dependencies.runner, current, runtime, false);
    if (before.publicInvoker) ownerAccess = before;
    else {
      const workspace = await prepareTerraformWorkspace(verifiedFoundation, true);
      const initialized = await terraformRunner.run('terraform', [
        `-chdir=${workspace.terraformDir}`,
        'init',
        '-input=false',
        '-lockfile=readonly',
        '-backend-config',
        `bucket=${options.stateBucket}`,
        '-backend-config',
        `prefix=assistant/${current.identity.installationId}`,
      ]);
      if (!initialized.ok)
        throw new Error('Owner-access Terraform init failed; retry the same inputs');
      const planPath = join(workspace.root, 'owner-access.tfplan');
      const planned = await terraformRunner.run('terraform', [
        `-chdir=${workspace.terraformDir}`,
        'plan',
        '-input=false',
        '-target=google_cloud_run_v2_service_iam_member.web_public',
        `-out=${planPath}`,
        ...terraformVars(current, options.stateBucket),
        ...runtimeVars(runtime),
        '-var',
        'allow_public_web_invoker=true',
      ]);
      if (!planned.ok) throw new Error('Owner-access Terraform plan failed; retry the same inputs');
      const shown = await terraformRunner.run('terraform', [
        `-chdir=${workspace.terraformDir}`,
        'show',
        '-json',
        planPath,
      ]);
      if (!shown.ok) throw new Error('Owner-access Terraform plan inspection failed');
      const plan = jsonOutput(shown, 'Owner-access Terraform plan') as {
        resource_changes?: Array<{
          address?: unknown;
          change?: { actions?: unknown; after?: Record<string, unknown> };
        }>;
      };
      const changes = plan.resource_changes;
      const binding = changes?.find(
        (change) =>
          change.address === 'google_cloud_run_v2_service_iam_member.web_public["current"]',
      );
      if (
        !Array.isArray(changes) ||
        !binding ||
        changes.some(
          (change) => change !== binding && JSON.stringify(change.change?.actions) !== '["no-op"]',
        ) ||
        JSON.stringify(binding.change?.actions) !== '["create"]' ||
        binding.change?.after?.member !== 'allUsers' ||
        binding.change?.after?.role !== 'roles/run.invoker' ||
        binding.change?.after?.name !== `${current.identity.installationId}-web`
      )
        throw new Error('Owner-access Terraform plan includes unexpected changes');
      const applied = await terraformRunner.run('terraform', [
        `-chdir=${workspace.terraformDir}`,
        'apply',
        '-input=false',
        '-auto-approve',
        planPath,
      ]);
      if (!applied.ok)
        throw new Error('Owner-access Terraform apply failed; retry the same inputs');
      ownerAccess = await inspectOwnerAccess(dependencies.runner, current, runtime, true);
      await rm(workspace.root, { recursive: true, force: true });
    }
  }
  return {
    manifest: current,
    applied: true,
    runtimeReady: false,
    completed: current.stage.completed,
    pending: current.stage.current === 'initialized' ? ['ready'] : ['initialized', 'ready'],
    ownerAccess,
    note: ownerAccess
      ? 'Web invocation is public for the operator-confirmed OAuth callback. Verify the customer OAuth client, owner sign-in, and an authenticated model response before claiming runtime readiness.'
      : current.stage.current === 'initialized'
        ? 'Customer-owned Cloud Run services and revisions verified. Owner sign-in, model response, and end-to-end readiness remain gated.'
        : 'Customer-owned foundation and READY indexes verified. Runtime services, owner authentication, and end-to-end readiness remain gated.',
  };
}
