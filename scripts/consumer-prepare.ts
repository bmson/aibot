/** Prepare private, local-only inputs for a fresh customer-owned installation. */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  createInstallationManifest,
  validateInstallationManifest,
} from '@assistant/setup/installation';
import { z } from 'zod';

const usage = `Usage: pnpm consumer:prepare --project-id ID --region REGION --installation-id ID \\
  --owner-name NAME --owner-email EMAIL --timezone IANA_ZONE \\
  --embedding-model MODEL --embedding-dimension 1536 \\
  --archive PATH --commit-sha SHA --archive-sha256 SHA [--output-dir PATH]

Prepares private local manifest and incomplete runtime-seed template files.
It never reads cloud credentials, calls Google Cloud, extracts the archive, or writes cloud resources.
The supplied release commit and archive digest are recorded; the archive digest is verified locally.
Model availability and current Vertex prices must be verified before completing the seed template.
`;

export interface ConsumerPrepareInput {
  projectId: string;
  region: string;
  installationId: string;
  ownerName: string;
  ownerEmail: string;
  timezone: string;
  archivePath: string;
  commitSha: string;
  archiveSha256: string;
  embeddingModel: string;
  embeddingDimension: number;
  outputDir: string;
  now?: Date;
  agentId?: string;
}

export interface ConsumerPrepareResult {
  manifestPath: string;
  seedTemplatePath: string;
  statePath: string;
  installCommandPath: string;
  projectId: string;
  region: string;
  installationId: string;
  commitSha: string;
  archiveDigest: string;
  seedStatus: 'incomplete-pricing-review-required';
}

const CURRENT_RUNTIME_EMBEDDING_DIMENSION = 1536;
const embeddingModelPattern = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;

async function digestArchive(archivePath: string): Promise<string> {
  const metadata = await lstat(archivePath);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error('release archive must be a regular local file');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archivePath)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

function safeTimezone(timezone: string): string {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    throw new Error('timezone must be a valid IANA time zone');
  }
  return timezone;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  await chmod(filePath, 0o600);
}

/** Create-only local setup artifacts; no cloud or credential interfaces exist here. */
export async function prepareConsumerInstallation(
  input: ConsumerPrepareInput,
): Promise<ConsumerPrepareResult> {
  const expectedDigest = `sha256:${input.archiveSha256.replace(/^sha256:/i, '').toLowerCase()}`;
  if (!/^sha256:[a-f0-9]{64}$/.test(expectedDigest))
    throw new Error('archive SHA-256 must contain exactly 64 hexadecimal characters');
  if (!/^[a-f0-9]{40}$/i.test(input.commitSha))
    throw new Error('release commit must be a full 40-character Git SHA');
  const ownerName = input.ownerName.trim();
  if (!ownerName) throw new Error('owner name cannot be empty');
  const ownerEmail = z.email().parse(input.ownerEmail.trim());
  if (!embeddingModelPattern.test(input.embeddingModel))
    throw new Error('embedding model must be a valid explicit Vertex model ID');
  if (input.embeddingDimension !== CURRENT_RUNTIME_EMBEDDING_DIMENSION)
    throw new Error(
      `embedding dimension must be ${CURRENT_RUNTIME_EMBEDDING_DIMENSION} for the current runtime`,
    );
  const actualDigest = await digestArchive(path.resolve(input.archivePath));
  if (actualDigest !== expectedDigest) throw new Error('release archive SHA-256 does not match');
  const timezone = safeTimezone(input.timezone);
  const createdAt = (input.now ?? new Date()).toISOString();
  const manifest = validateInstallationManifest(
    createInstallationManifest({
      identity: {
        installationId: input.installationId,
        projectId: input.projectId,
        region: input.region,
        databaseId: `assistant-${input.installationId}`,
        release: {
          commitSha: input.commitSha.toLowerCase(),
          archiveDigest: actualDigest,
        },
      },
      modules: [],
      modelProvider: 'google',
      embeddingModel: input.embeddingModel,
      embeddingDimension: input.embeddingDimension,
      resources: [],
      createdAt,
    }),
  );

  const outputDir = path.resolve(input.outputDir);
  const outputParent = path.dirname(outputDir);
  try {
    const parentStats = await lstat(outputParent);
    if (!parentStats.isDirectory() || parentStats.isSymbolicLink())
      throw new Error('output parent must be a real directory, not a symbolic link');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(outputParent, { mode: 0o700 });
  }
  const parentStats = await lstat(outputParent);
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink())
    throw new Error('output parent must be a real directory, not a symbolic link');
  await mkdir(outputDir, { recursive: false, mode: 0o700 });
  await chmod(outputDir, 0o700);
  const ownedOutput = await lstat(outputDir);
  const manifestPath = path.join(outputDir, 'install-manifest.json');
  const seedTemplatePath = path.join(outputDir, 'seed-plan.template.json');
  const statePath = path.join(outputDir, 'installation-state.json');
  const installCommandPath = path.join(outputDir, 'consumer-install-command.txt');
  const stateBucket = `${input.projectId}-${input.installationId}-state`;

  const seedTemplate = {
    schemaVersion: 1,
    projectId: input.projectId,
    installationId: input.installationId,
    seedAt: createdAt,
    agent: {
      id: input.agentId ?? randomUUID(),
      name: ownerName,
      email: ownerEmail,
      timezone,
      locale: 'en-US',
      signature: '',
    },
    budget: {
      dailyLimitMicros: null,
      monthlyLimitMicros: null,
      softPct: null,
    },
    embeddingSpace: {
      provider: 'vertex',
      model: input.embeddingModel,
      dimensions: input.embeddingDimension,
      revision: 'customer-seed-v1',
    },
    models: [],
    roles: [],
    _completionGate:
      'Incomplete review template: verify current regional Vertex model availability, capabilities, and USD token prices and sources before supplying any catalog or role assignments. This file is not a valid consumer:seed-runtime input.',
  };

  try {
    await writePrivateJson(manifestPath, manifest);
    await writePrivateJson(seedTemplatePath, seedTemplate);
    await writeFile(
      path.join(outputDir, 'README.txt'),
      [
        'Private, local-only preparation for a fresh Assistant installation.',
        'The seed-plan.template.json is intentionally incomplete and cannot be applied.',
        'The selected embedding model is recorded in both manifest and seed template. Verify its availability, capabilities, and current prices for the chosen Vertex location before completing the model catalog, roles, and budget.',
        'The installation-state.json path is reserved for consumer:install; it is not pre-created or advanced here.',
        'The selected database is create-only. Provisioning must verify absence and must refuse to adopt an existing database.',
        '',
        `Project: ${input.projectId}`,
        `Region: ${input.region}`,
        `Installation: ${input.installationId}`,
        `Release commit: ${manifest.identity.release.commitSha}`,
        `Release archive digest: ${actualDigest}`,
        `Manifest: ${manifestPath}`,
        `Incomplete seed template: ${seedTemplatePath}`,
        `Future local state path: ${statePath}`,
        `Customer Terraform state bucket: ${stateBucket}`,
        `Install preview command: ${installCommandPath}`,
        'Run the saved preview command from the matching Assistant release checkout. It performs read-only customer cloud checks; add --apply only when ready to provision.',
        '',
      ].join('\n'),
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
    await chmod(path.join(outputDir, 'README.txt'), 0o600);
    const installCommand = [
      'pnpm consumer:install',
      `--manifest ${shellQuote(manifestPath)}`,
      `--archive ${shellQuote(path.resolve(input.archivePath))}`,
      `--state ${shellQuote(statePath)}`,
      `--state-bucket ${shellQuote(stateBucket)}`,
      '--terraform-dir infra/gcp/consumer/terraform',
      '',
    ].join(' ');
    await writeFile(installCommandPath, installCommand, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await chmod(installCommandPath, 0o600);
  } catch (error) {
    // This output directory was created exclusively by this invocation. Remove
    // partial artifacts so a retry never mistakes them for a complete prepare.
    const { rm } = await import('node:fs/promises');
    try {
      const current = await lstat(outputDir);
      if (
        current.isDirectory() &&
        !current.isSymbolicLink() &&
        current.dev === ownedOutput.dev &&
        current.ino === ownedOutput.ino
      )
        await rm(outputDir, { recursive: true, force: true });
    } catch {
      // A missing, replaced, or unreadable path is left untouched. In
      // particular, cleanup never traverses a symlink substituted mid-run.
    }
    throw error;
  }

  return {
    manifestPath,
    seedTemplatePath,
    statePath,
    installCommandPath,
    projectId: input.projectId,
    region: input.region,
    installationId: input.installationId,
    commitSha: manifest.identity.release.commitSha,
    archiveDigest: actualDigest,
    seedStatus: 'incomplete-pricing-review-required',
  };
}

export async function runConsumerPrepareCli(argv = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      'project-id': { type: 'string' },
      region: { type: 'string' },
      'installation-id': { type: 'string' },
      'owner-name': { type: 'string' },
      'owner-email': { type: 'string' },
      timezone: { type: 'string' },
      'embedding-model': { type: 'string' },
      'embedding-dimension': { type: 'string' },
      archive: { type: 'string' },
      'commit-sha': { type: 'string' },
      'archive-sha256': { type: 'string' },
      'output-dir': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(usage);
    return;
  }
  const required = [
    ['--project-id', values['project-id']],
    ['--region', values.region],
    ['--installation-id', values['installation-id']],
    ['--owner-name', values['owner-name']],
    ['--owner-email', values['owner-email']],
    ['--timezone', values.timezone],
    ['--embedding-model', values['embedding-model']],
    ['--embedding-dimension', values['embedding-dimension']],
    ['--archive', values.archive],
    ['--commit-sha', values['commit-sha']],
    ['--archive-sha256', values['archive-sha256']],
  ] as const;
  const missing = required.find(([, value]) => !value);
  if (missing) throw new Error(`${missing[0]} is required; use --help for usage`);
  const installationId = values['installation-id'] as string;
  const outputDir = values['output-dir'] ?? path.join('.assistant-install', installationId);
  const result = await prepareConsumerInstallation({
    projectId: values['project-id'] as string,
    region: values.region as string,
    installationId,
    ownerName: values['owner-name'] as string,
    ownerEmail: values['owner-email'] as string,
    timezone: values.timezone as string,
    embeddingModel: values['embedding-model'] as string,
    embeddingDimension: Number(values['embedding-dimension']),
    archivePath: values.archive as string,
    commitSha: values['commit-sha'] as string,
    archiveSha256: values['archive-sha256'] as string,
    outputDir,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runConsumerPrepareCli().catch((error: unknown) => {
    process.stderr.write(
      `consumer:prepare: ${error instanceof Error ? error.message : 'preparation failed'}\n`,
    );
    process.exitCode = 1;
  });
}
