import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type CommandRunner,
  type PublishOptions,
  publishConsumerImages,
  systemCommand,
} from './consumer-publish-images.js';

const roots: string[] = [];
afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'consumer-image-test-'));
  roots.push(root);
  await mkdir(path.join(root, 'infra/docker'), { recursive: true });
  await mkdir(path.join(root, 'apps/web'), { recursive: true });
  await writeFile(path.join(root, '.dockerignore'), '.env\n.env.*\n!.env.example\n');
  await writeFile(path.join(root, '.env.example'), 'EXAMPLE=true\n');
  for (const name of ['web', 'agent']) {
    await writeFile(
      path.join(root, 'infra/docker', `${name}.Dockerfile`),
      `FROM scratch\nARG GIT_SHA=unknown\nENV BUILD_SHA=\${GIT_SHA}\n`,
    );
  }
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ],
    { cwd: root },
  );
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  await writeFile(path.join(root, 'apps/web/.env.local'), 'AUTH_DEV_BYPASS=true\nSECRET=local\n');
  return { root, sha };
}

function options(sha: string, outputPath?: string): PublishOptions {
  return {
    projectId: 'customer-project',
    region: 'us-west1',
    repositoryId: 'assistant-runtime',
    sourceSha: sha,
    dryRun: outputPath === undefined,
    outputPath,
  };
}

function fakePublisher(
  sha: string,
  behavior?: {
    wrongSha?: boolean;
    badDigest?: boolean;
    mutableRepository?: boolean;
    authFailure?: boolean;
    authNoConfig?: boolean;
  },
) {
  const calls: Array<{ command: string; args: readonly string[]; dockerConfig?: string }> = [];
  let sawLocalEnv = false;
  const runner: CommandRunner = async (command, args, config) => {
    calls.push({ command, args, dockerConfig: config.env?.DOCKER_CONFIG });
    if (command === 'git' || command === 'tar') return systemCommand(command, args, config);
    if (command === 'gcloud' && args[0] === 'auth') {
      if (behavior?.authFailure) throw new Error('sensitive gcloud diagnostic');
      if (behavior?.authNoConfig) return '';
      const dockerConfig = config.env?.DOCKER_CONFIG;
      if (!dockerConfig) throw new Error('missing isolated Docker config');
      await writeFile(
        path.join(dockerConfig, 'config.json'),
        JSON.stringify({
          credHelpers: { 'us-west1-docker.pkg.dev': 'gcloud' },
        }),
      );
      return '';
    }
    if (command === 'gcloud')
      return JSON.stringify({
        name: 'projects/customer-project/locations/us-west1/repositories/assistant-runtime',
        format: 'DOCKER',
        dockerConfig: { immutableTags: !behavior?.mutableRepository },
      });
    if (command !== 'docker') throw new Error(`unexpected ${command}`);
    if (args[0] === 'buildx') {
      const tag = args[args.indexOf('--tag') + 1] ?? '';
      const name = tag.includes('/web:') ? 'web' : 'agent';
      const context = args.at(-1) ?? '';
      try {
        await stat(path.join(context, 'apps/web/.env.local'));
        sawLocalEnv = true;
      } catch {
        // The untracked local override must never enter the source archive.
      }
      const digest = behavior?.badDigest
        ? 'sha256:bad'
        : `sha256:${(name === 'web' ? 'a' : 'b').repeat(64)}`;
      const metadata = args[args.indexOf('--metadata-file') + 1] ?? '';
      await writeFile(metadata, JSON.stringify({ 'containerimage.digest': digest }));
      return '';
    }
    if (args[0] === 'pull') return '';
    if (args[0] === 'image')
      return JSON.stringify([`BUILD_SHA=${behavior?.wrongSha ? '0'.repeat(40) : sha}`]);
    throw new Error(`unexpected docker command ${args[0]}`);
  };
  return {
    calls,
    runner,
    get sawLocalEnv() {
      return sawLocalEnv;
    },
  };
}

describe('customer-owned image publisher', () => {
  it('requires explicit customer target and full source SHA before any command', async () => {
    const seen: string[] = [];
    await expect(
      publishConsumerImages(
        { ...options('abc'), projectId: '' },
        {
          runner: async (command) => {
            seen.push(command);
            return '';
          },
        },
      ),
    ).rejects.toThrow('project ID must be explicit');
    await expect(publishConsumerImages(options('abc'))).rejects.toThrow('full lowercase');
    await expect(
      publishConsumerImages({ ...options('a'.repeat(40)), dryRun: false }),
    ).rejects.toThrow('--output is required');
    expect(seen).toEqual([]);
  });

  it('dry-runs from the committed archive without Google auth, Docker, or local env files', async () => {
    const { root, sha } = await fixture();
    const seen: string[] = [];
    const runner: CommandRunner = async (command, args, config) => {
      seen.push(command);
      if (command !== 'git' && command !== 'tar')
        throw new Error('dry-run reached cloud or Docker');
      return systemCommand(command, args, config);
    };
    const result = await publishConsumerImages(options(sha), { repoRoot: root, runner });
    expect(result).toMatchObject({
      dryRun: true,
      sourceSha: sha,
      sourceArchiveDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      tags: { web: `us-west1-docker.pkg.dev/customer-project/assistant-runtime/web:${sha}` },
    });
    expect(seen).toEqual(['git', 'git', 'tar']);
  });

  it('rejects a committed env override before contacting Google or Docker', async () => {
    const { root } = await fixture();
    execFileSync('git', ['add', 'apps/web/.env.local', '-f'], { cwd: root });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--quiet',
        '-m',
        'bad',
      ],
      { cwd: root },
    );
    const badSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    const seen: string[] = [];
    const runner: CommandRunner = async (command, args, config) => {
      seen.push(command);
      if (command !== 'git' && command !== 'tar') throw new Error('unexpected external call');
      return systemCommand(command, args, config);
    };
    await expect(
      publishConsumerImages(options(badSha), { repoRoot: root, runner }),
    ).rejects.toThrow('forbidden file: apps/web/.env.local');
    expect(seen).toEqual(['git', 'git', 'tar']);
  });

  it('publishes only to the exact customer repository and records verified digests', async () => {
    const { root, sha } = await fixture();
    const outputPath = path.join(root, 'published.json');
    const fake = fakePublisher(sha);
    const result = await publishConsumerImages(options(sha, outputPath), {
      repoRoot: root,
      runner: fake.runner,
    });
    expect(result).toMatchObject({
      schemaVersion: 1,
      sourceSha: sha,
      terraform: {
        web_image_digest: `sha256:${'a'.repeat(64)}`,
        agent_image_digest: `sha256:${'b'.repeat(64)}`,
      },
    });
    const saved = JSON.parse(await readFile(outputPath, 'utf8'));
    expect(saved).toEqual(result);
    expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
    expect(fake.sawLocalEnv).toBe(false);
    expect(fake.calls.find((call) => call.command === 'gcloud')?.args).toContain(
      'customer-project',
    );
    const configured = fake.calls.find(
      (call) => call.command === 'gcloud' && call.args[0] === 'auth',
    );
    expect(configured?.args).toEqual([
      'auth',
      'configure-docker',
      'us-west1-docker.pkg.dev',
      '--quiet',
    ]);
    expect(configured?.dockerConfig).toBeTruthy();
    const builds = fake.calls.filter(
      (call) => call.command === 'docker' && call.args[0] === 'buildx',
    );
    expect(builds).toHaveLength(2);
    expect(
      fake.calls
        .filter((call) => call.command === 'docker')
        .every((call) => call.dockerConfig === configured?.dockerConfig),
    ).toBe(true);
    await expect(stat(configured?.dockerConfig ?? '')).rejects.toMatchObject({ code: 'ENOENT' });
    for (const build of builds) {
      expect(build.args).toContain(`GIT_SHA=${sha}`);
      expect(build.args).toContain('--provenance=false');
      expect(build.args).toContain('--push');
      expect(build.args[build.args.indexOf('--tag') + 1]).toMatch(
        new RegExp(
          `^us-west1-docker\\.pkg\\.dev/customer-project/assistant-runtime/(web|agent):${sha}$`,
        ),
      );
    }
    expect(
      fake.calls.filter((call) => call.command === 'docker' && call.args[0] === 'pull'),
    ).toHaveLength(2);
  });

  it('fails before pushing when isolated Docker authentication cannot be configured', async () => {
    const { root, sha } = await fixture();
    const outputPath = path.join(root, 'published.json');
    const fake = fakePublisher(sha, { authFailure: true });
    await expect(
      publishConsumerImages(options(sha, outputPath), { repoRoot: root, runner: fake.runner }),
    ).rejects.toThrow('Could not configure Docker authentication for us-west1-docker.pkg.dev');
    expect(fake.calls.some((call) => call.command === 'docker')).toBe(false);
    await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails before pushing when gcloud does not write the scoped helper', async () => {
    const { root, sha } = await fixture();
    const outputPath = path.join(root, 'published.json');
    const fake = fakePublisher(sha, { authNoConfig: true });
    await expect(
      publishConsumerImages(options(sha, outputPath), { repoRoot: root, runner: fake.runner }),
    ).rejects.toThrow('Docker authentication for us-west1-docker.pkg.dev was not configured');
    expect(fake.calls.some((call) => call.command === 'docker')).toBe(false);
    await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an unverified remote BUILD_SHA without writing a digest manifest', async () => {
    const { root, sha } = await fixture();
    const outputPath = path.join(root, 'published.json');
    const fake = fakePublisher(sha, { wrongSha: true });
    await expect(
      publishConsumerImages(options(sha, outputPath), { repoRoot: root, runner: fake.runner }),
    ).rejects.toThrow('does not embed the requested BUILD_SHA');
    await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a mutable customer repository before building either image', async () => {
    const { root, sha } = await fixture();
    const outputPath = path.join(root, 'published.json');
    const fake = fakePublisher(sha, { mutableRepository: true });
    await expect(
      publishConsumerImages(options(sha, outputPath), { repoRoot: root, runner: fake.runner }),
    ).rejects.toThrow('immutable tags');
    expect(fake.calls.some((call) => call.command === 'docker')).toBe(false);
    await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects malformed build metadata without writing a digest manifest', async () => {
    const { root, sha } = await fixture();
    const outputPath = path.join(root, 'published.json');
    const fake = fakePublisher(sha, { badDigest: true });
    await expect(
      publishConsumerImages(options(sha, outputPath), { repoRoot: root, runner: fake.runner }),
    ).rejects.toThrow('did not produce an immutable SHA-256 digest');
    await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
