/** Publish only the two minimal runtime images from an explicit committed source SHA. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, mkdir, mkdtemp, open, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SOURCE_SHA = /^[0-9a-f]{40}$/;
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const REGION = /^[a-z][a-z0-9-]+[0-9]$/;
const REPOSITORY = /^[a-z][a-z0-9-]{1,62}[a-z0-9]$/;
const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface PublishOptions {
  projectId: string;
  region: string;
  repositoryId: string;
  sourceSha: string;
  dryRun: boolean;
  outputPath?: string;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; capture?: boolean },
) => Promise<string>;

/** Child output is never echoed: build/auth diagnostics can contain sensitive data. */
export const systemCommand: CommandRunner = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      if (!options.capture) return;
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) {
        child.kill();
        reject(new Error(`${command} returned too much output`));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.resume();
    child.on('error', () => reject(new Error(`${command} could not start`)));
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`${command} failed with exit code ${code ?? 'unknown'}`));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });

function validateOptions(options: PublishOptions): void {
  if (!PROJECT_ID.test(options.projectId)) throw new Error('project ID must be explicit and valid');
  if (!REGION.test(options.region)) throw new Error('region must be explicit and valid');
  if (!REPOSITORY.test(options.repositoryId))
    throw new Error('Artifact Registry repository ID must be explicit and valid');
  if (!SOURCE_SHA.test(options.sourceSha))
    throw new Error('source SHA must be an explicit full lowercase 40-character commit SHA');
  if (!options.dryRun && !options.outputPath)
    throw new Error('--output is required when publishing');
}

function imageRoot(options: PublishOptions): string {
  return `${options.region}-docker.pkg.dev/${options.projectId}/${options.repositoryId}`;
}

function forbiddenSourcePath(relative: string): boolean {
  return relative.split(path.sep).some((name) => {
    if (name === '.env.example') return false;
    return (
      name === '.env' ||
      name.startsWith('.env.') ||
      name === '.npmrc' ||
      name === '.pypirc' ||
      /\.(?:pem|p8|key)$/i.test(name) ||
      /^(?:credentials|service-account)(?:[.-].*)?\.json$/i.test(name)
    );
  });
}

async function inspectArchiveContext(context: string): Promise<void> {
  const pending = [''];
  while (pending.length) {
    const relative = pending.pop() ?? '';
    for (const entry of await readdir(path.join(context, relative), { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (forbiddenSourcePath(child))
        throw new Error(`committed source includes forbidden file: ${child}`);
      if (entry.isSymbolicLink()) throw new Error(`committed source includes a symlink: ${child}`);
      if (entry.isDirectory()) pending.push(child);
    }
  }
  const ignore = await readFile(path.join(context, '.dockerignore'), 'utf8');
  const lines = new Set(ignore.split(/\r?\n/).map((line) => line.trim()));
  if (!lines.has('.env') || !lines.has('.env.*'))
    throw new Error('committed .dockerignore must exclude .env and .env.*');
  for (const name of ['web', 'agent'] as const) {
    const dockerfile = await readFile(
      path.join(context, 'infra/docker', `${name}.Dockerfile`),
      'utf8',
    );
    if (!/^ARG GIT_SHA=/m.test(dockerfile) || !/^ENV BUILD_SHA=\$\{GIT_SHA\}$/m.test(dockerfile))
      throw new Error(`${name} Dockerfile must embed the explicit GIT_SHA as BUILD_SHA`);
  }
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

async function verifyRepository(options: PublishOptions, runner: CommandRunner, cwd: string) {
  const response = await runner(
    'gcloud',
    [
      'artifacts',
      'repositories',
      'describe',
      options.repositoryId,
      '--project',
      options.projectId,
      '--location',
      options.region,
      '--format=json',
    ],
    { cwd, capture: true },
  );
  let repository: unknown;
  try {
    repository = JSON.parse(response);
  } catch {
    throw new Error('customer Artifact Registry repository metadata is not valid JSON');
  }
  const expected = `projects/${options.projectId}/locations/${options.region}/repositories/${options.repositoryId}`;
  if (
    !repository ||
    typeof repository !== 'object' ||
    !('name' in repository) ||
    repository.name !== expected ||
    !('format' in repository) ||
    repository.format !== 'DOCKER' ||
    !('dockerConfig' in repository) ||
    !repository.dockerConfig ||
    typeof repository.dockerConfig !== 'object' ||
    !('immutableTags' in repository.dockerConfig) ||
    repository.dockerConfig.immutableTags !== true
  ) {
    throw new Error('target must be the exact customer Docker repository with immutable tags');
  }
}

async function publishOne(
  name: 'web' | 'agent',
  options: PublishOptions,
  context: string,
  scratch: string,
  runner: CommandRunner,
) {
  const root = imageRoot(options);
  const tag = `${root}/${name}:${options.sourceSha}`;
  const metadataPath = path.join(scratch, `${name}-metadata.json`);
  await runner(
    'docker',
    [
      'buildx',
      'build',
      '--platform',
      'linux/amd64',
      '--file',
      path.join(context, 'infra/docker', `${name}.Dockerfile`),
      '--build-arg',
      `GIT_SHA=${options.sourceSha}`,
      '--metadata-file',
      metadataPath,
      '--tag',
      tag,
      '--push',
      context,
    ],
    { cwd: context },
  );
  let metadata: unknown;
  try {
    metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  } catch {
    throw new Error(`${name} build did not write valid digest metadata`);
  }
  const digest =
    metadata && typeof metadata === 'object' && 'containerimage.digest' in metadata
      ? metadata['containerimage.digest']
      : null;
  if (typeof digest !== 'string' || !DIGEST.test(digest))
    throw new Error(`${name} build did not produce an immutable SHA-256 digest`);
  const reference = `${root}/${name}@${digest}`;
  await runner('docker', ['pull', '--platform', 'linux/amd64', reference], { cwd: context });
  const rawEnv = await runner(
    'docker',
    ['image', 'inspect', '--format', '{{json .Config.Env}}', reference],
    {
      cwd: context,
      capture: true,
    },
  );
  let env: unknown;
  try {
    env = JSON.parse(rawEnv);
  } catch {
    throw new Error(`${name} published image configuration is not valid JSON`);
  }
  if (!Array.isArray(env) || !env.includes(`BUILD_SHA=${options.sourceSha}`))
    throw new Error(`${name} published digest does not embed the requested BUILD_SHA`);
  return { digest, reference, tag };
}

async function writeNewManifest(outputPath: string, value: unknown): Promise<void> {
  const handle = await open(outputPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
  } catch (error) {
    await rm(outputPath, { force: true });
    throw error;
  } finally {
    await handle.close();
  }
}

/** Dry-run validates the exact Git archive and needs neither Docker nor Google auth. */
export async function publishConsumerImages(
  options: PublishOptions,
  dependencies: { repoRoot?: string; runner?: CommandRunner } = {},
) {
  validateOptions(options);
  const repoRoot = dependencies.repoRoot ?? defaultRepoRoot;
  const runner = dependencies.runner ?? systemCommand;
  const resolvedSha = (
    await runner('git', ['rev-parse', '--verify', `${options.sourceSha}^{commit}`], {
      cwd: repoRoot,
      capture: true,
    })
  ).trim();
  if (resolvedSha !== options.sourceSha)
    throw new Error('source SHA is not the exact local commit');
  if (!options.dryRun && options.outputPath) {
    await access(path.dirname(options.outputPath), constants.W_OK);
    try {
      await access(options.outputPath);
      throw new Error('output manifest already exists');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  const scratch = await mkdtemp(path.join(tmpdir(), 'assistant-consumer-images-'));
  try {
    const archivePath = path.join(scratch, 'source.tar');
    const context = path.join(scratch, 'context');
    await runner('git', ['archive', '--format=tar', `--output=${archivePath}`, options.sourceSha], {
      cwd: repoRoot,
    });
    await mkdir(context);
    await runner('tar', ['-xf', archivePath, '-C', context], { cwd: repoRoot });
    await inspectArchiveContext(context);
    const sourceArchiveDigest = await sha256File(archivePath);
    const root = imageRoot(options);
    const plan = {
      sourceSha: options.sourceSha,
      sourceArchiveDigest,
      projectId: options.projectId,
      region: options.region,
      repositoryId: options.repositoryId,
      tags: {
        web: `${root}/web:${options.sourceSha}`,
        agent: `${root}/agent:${options.sourceSha}`,
      },
    };
    if (options.dryRun) return { dryRun: true as const, ...plan };
    await verifyRepository(options, runner, repoRoot);
    const web = await publishOne('web', options, context, scratch, runner);
    const agent = await publishOne('agent', options, context, scratch, runner);
    const manifest = {
      schemaVersion: 1,
      ...plan,
      images: { web, agent },
      terraform: { web_image_digest: web.digest, agent_image_digest: agent.digest },
    };
    await writeNewManifest(options.outputPath as string, manifest);
    return manifest;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const usage = `Usage: pnpm consumer:publish-images --project PROJECT --region REGION --repository REPO --source-sha FULL_COMMIT_SHA --output PATH [--dry-run]

Dry-run validates a committed source archive without Docker or Google auth and writes no output file.
Publishing builds web and agent from that archive into the specified customer Artifact Registry repository,
verifies both remote digests embed BUILD_SHA, and writes a new digest manifest for Terraform.
`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: 'string' },
      region: { type: 'string' },
      repository: { type: 'string' },
      'source-sha': { type: 'string' },
      output: { type: 'string' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(usage);
    return;
  }
  const required = [
    ['--project', values.project],
    ['--region', values.region],
    ['--repository', values.repository],
    ['--source-sha', values['source-sha']],
  ] as const;
  const missing = required.find(([, value]) => !value)?.[0];
  if (missing) throw new Error(`missing ${missing}\n\n${usage.trim()}`);
  const result = await publishConsumerImages({
    projectId: values.project as string,
    region: values.region as string,
    repositoryId: values.repository as string,
    sourceSha: values['source-sha'] as string,
    dryRun: values['dry-run'] === true,
    outputPath: values.output ? path.resolve(values.output) : undefined,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `consumer:publish-images: ${error instanceof Error ? error.message : 'failed'}\n`,
    );
    process.exitCode = 1;
  });
}
