import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareConsumerInstallation } from './consumer-prepare.js';

const temporaryDirectories: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'assistant-consumer-prepare-'));
  temporaryDirectories.push(root);
  const archivePath = path.join(root, 'release.tar.gz');
  await writeFile(archivePath, 'fixture release archive bytes');
  const archiveSha256 = createHash('sha256')
    .update(await readFile(archivePath))
    .digest('hex');
  return {
    root,
    archivePath,
    archiveSha256,
    input: {
      projectId: 'customer-project-123',
      region: 'us-west1',
      installationId: 'customer-assistant',
      ownerName: 'Private Owner',
      ownerEmail: 'private@example.com',
      timezone: 'America/Los_Angeles',
      archivePath,
      commitSha: '0123456789abcdef0123456789abcdef01234567',
      archiveSha256,
      embeddingModel: 'gemini-embedding-001',
      embeddingDimension: 1536,
      outputDir: path.join(root, 'prepared'),
      now: new Date('2026-09-23T12:00:00.000Z'),
      agentId: '11111111-1111-4111-8111-111111111111',
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('prepareConsumerInstallation', () => {
  it('writes a validated fresh-install manifest and a clearly incomplete private seed template', async () => {
    const { input } = await fixture();
    const result = await prepareConsumerInstallation(input);
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8')) as {
      identity: {
        projectId: string;
        region: string;
        installationId: string;
        databaseId: string;
        release: { commitSha: string; archiveDigest: string };
      };
      selection: {
        profile: string;
        modules: string[];
        modelProvider: string;
        embeddingModel?: string;
        embeddingDimension?: number;
        backupSchedule?: { recurrence: string; retentionDays: number };
      };
      resources: unknown[];
      stage: { current: string; completed: string[] };
    };
    const seed = JSON.parse(await readFile(result.seedTemplatePath, 'utf8')) as {
      agent: { id: string; name: string; email: string; timezone: string };
      models: unknown[];
      roles: unknown[];
      embeddingSpace: { model: string; dimensions: number };
      budget: { dailyLimitMicros: number | null };
      _completionGate: string;
    };
    const directoryStats = await stat(input.outputDir);
    const manifestStats = await stat(result.manifestPath);
    const command = await readFile(result.installCommandPath, 'utf8');

    expect(manifest.identity).toMatchObject({
      projectId: input.projectId,
      region: input.region,
      installationId: input.installationId,
      databaseId: 'assistant-customer-assistant',
      release: {
        commitSha: input.commitSha,
        archiveDigest: `sha256:${input.archiveSha256}`,
      },
    });
    expect(manifest.selection).toMatchObject({
      profile: 'firestore',
      modules: [],
      modelProvider: 'google',
      embeddingModel: input.embeddingModel,
      embeddingDimension: input.embeddingDimension,
    });
    expect(manifest.selection.backupSchedule).toBeUndefined();
    expect(manifest.resources).toEqual([]);
    expect(manifest.stage).toMatchObject({ current: 'previewed', completed: ['previewed'] });
    expect(seed.agent).toMatchObject({
      id: input.agentId,
      name: input.ownerName,
      email: input.ownerEmail,
      timezone: input.timezone,
    });
    expect(seed.models).toEqual([]);
    expect(seed.roles).toEqual([]);
    expect(seed.embeddingSpace).toMatchObject({
      model: input.embeddingModel,
      dimensions: input.embeddingDimension,
    });
    expect(seed.budget.dailyLimitMicros).toBeNull();
    expect(seed._completionGate).toContain('not a valid consumer:seed-runtime input');
    expect(result.statePath).toBe(path.join(input.outputDir, 'installation-state.json'));
    expect(command).toContain("--state-bucket 'customer-project-123-customer-assistant-state'");
    expect(command).toContain(`--archive '${input.archivePath}'`);
    expect(await stat(result.statePath).catch(() => null)).toBeNull();
    expect(directoryStats.mode & 0o777).toBe(0o700);
    expect(manifestStats.mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(input.outputDir, 'README.txt'), 'utf8')).not.toContain(
      input.ownerEmail,
    );
    expect(result.seedStatus).toBe('incomplete-pricing-review-required');
  });

  it('persists an opted-in backup retention choice in the prepared installation manifest', async () => {
    const { input } = await fixture();
    const result = await prepareConsumerInstallation({ ...input, dailyBackupRetentionDays: 14 });
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8')) as {
      selection: { backupSchedule?: { recurrence: string; retentionDays: number } };
    };
    expect(manifest.selection.backupSchedule).toEqual({ recurrence: 'daily', retentionDays: 14 });
  });

  it('rejects out-of-range daily backup retention before writing setup artifacts', async () => {
    const { input } = await fixture();
    await expect(
      prepareConsumerInstallation({ ...input, dailyBackupRetentionDays: 99 }),
    ).rejects.toThrow('daily backup retention must be a whole number from 1 through 98 days');
    await expect(stat(input.outputDir).catch(() => null)).resolves.toBeNull();
  });

  it('rejects an archive whose bytes do not match the supplied SHA before creating output', async () => {
    const { input } = await fixture();
    await expect(
      prepareConsumerInstallation({ ...input, archiveSha256: 'a'.repeat(64) }),
    ).rejects.toThrow('release archive SHA-256 does not match');
    await expect(stat(input.outputDir)).rejects.toThrow();
  });

  it('rejects embedding dimensions the current runtime cannot use', async () => {
    const { input } = await fixture();
    await expect(
      prepareConsumerInstallation({ ...input, embeddingDimension: 512 }),
    ).rejects.toThrow('embedding dimension must be 1536 for the current runtime');
    await expect(stat(input.outputDir)).rejects.toThrow();
  });

  it('refuses to reuse an existing install directory', async () => {
    const { input } = await fixture();
    await prepareConsumerInstallation(input);
    await expect(prepareConsumerInstallation(input)).rejects.toThrow();
  });

  it('rejects symlinked archives and invalid time zones', async () => {
    const { input, root } = await fixture();
    const linkedArchive = path.join(root, 'linked.tar.gz');
    await symlink(input.archivePath, linkedArchive);
    await expect(
      prepareConsumerInstallation({ ...input, archivePath: linkedArchive }),
    ).rejects.toThrow('release archive must be a regular local file');
    await expect(
      prepareConsumerInstallation({ ...input, timezone: 'Not/A_Timezone' }),
    ).rejects.toThrow('timezone must be a valid IANA time zone');
  });

  it('refuses symlinked output parents and preserves an existing symlink target', async () => {
    const { input, root } = await fixture();
    const target = path.join(root, 'existing-output');
    await mkdir(target);
    const sentinel = path.join(target, 'keep.txt');
    await writeFile(sentinel, 'keep');

    const linkedTarget = path.join(root, 'output-link');
    await symlink(target, linkedTarget, 'dir');
    await expect(
      prepareConsumerInstallation({ ...input, outputDir: linkedTarget }),
    ).rejects.toThrow();
    await expect(readFile(sentinel, 'utf8')).resolves.toBe('keep');

    const linkedParent = path.join(root, 'parent-link');
    await symlink(root, linkedParent, 'dir');
    await expect(
      prepareConsumerInstallation({ ...input, outputDir: path.join(linkedParent, 'new-output') }),
    ).rejects.toThrow('output parent must be a real directory, not a symbolic link');
    await expect(readFile(sentinel, 'utf8')).resolves.toBe('keep');
  });
});
