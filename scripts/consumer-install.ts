import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createInstallationStore } from '@assistant/firestore';
import {
  type ConsumerInstallDependencies,
  type ConsumerInstallOptions,
  type ConsumerInstallResult,
  provisionConsumerInstallation,
  systemRunner,
  validateInstallationManifest,
} from '@assistant/setup/installation';
import { publishConsumerImages } from './consumer-publish-images.js';
import {
  applyConsumerRuntimeSeed,
  type ConsumerRuntimeSeedPlan,
  planConsumerRuntimeSeed,
} from './consumer-runtime-seed.js';

const usage = `Usage: pnpm consumer:install --manifest PATH --archive PATH --state PATH --state-bucket NAME --terraform-dir PATH [--seed-plan PATH] [--images PATH --runtime-config PATH] [--owner-access-callback HTTPS_URL] [--apply]

Without --apply this verifies the release archive, customer project billing, and selected Firestore database absence.
With --apply it bootstraps customer-owned state, runs Terraform, and records resumable foundation stages.
Supply both --images and --runtime-config to opt in to digest-pinned Cloud Run deployment after the foundation.
Supply --seed-plan with an explicit customer runtime seed plan to create required data before Cloud Run.
On an initialized private runtime, pass --owner-access-callback with the exact Google OAuth Web client redirect URI. Preview is read-only; --apply grants public invocation to web only after the customer has configured the OAuth client and HTTPS routing.
On an already provisioned foundation, --build-images --runtime-config PATH --apply builds and pushes the exact source commit's web and agent images into the customer repository, then deploys those digests. Docker Buildx and Artifact Registry Docker authentication must already work.
`;

type SeedSummary = {
  status: 'planned' | 'seeded' | 'already_seeded';
  planHash: string;
  recordCount: number;
  agentId: string;
};

function validateSeedScope(plan: ConsumerRuntimeSeedPlan, options: ConsumerInstallOptions): void {
  const manifest = validateInstallationManifest(options.manifest);
  const space = plan.input.embeddingSpace;
  if (
    plan.input.projectId !== manifest.identity.projectId ||
    plan.input.installationId !== manifest.identity.installationId
  )
    throw new Error('Runtime seed project and installation must match the manifest');
  if (manifest.selection.modelProvider !== 'google')
    throw new Error('Runtime seed requires the Google provider');
  if (
    manifest.selection.embeddingModel !== space.model ||
    manifest.selection.embeddingDimension !== space.dimensions
  )
    throw new Error('Runtime seed embedding model and dimensions must match the manifest');
  if (options.runtime) {
    const config = options.runtime.config as Record<string, unknown> | null;
    const runtimeSpace = config?.firestoreEmbeddingSpace as Record<string, unknown> | null;
    if (
      config?.firestoreAgentId !== plan.input.agent.id ||
      config?.ownerEmail !== plan.input.agent.email ||
      runtimeSpace?.provider !== space.provider ||
      runtimeSpace?.model !== space.model ||
      runtimeSpace?.dimensions !== space.dimensions ||
      runtimeSpace?.revision !== space.revision
    )
      throw new Error('Runtime config agent, owner, or embedding space differs from seed plan');
  }
}

/** Keep the create-only seed outside the setup package and before runtime deployment. */
export async function provisionConsumerInstallationWithSeed(
  dependencies: ConsumerInstallDependencies,
  options: ConsumerInstallOptions & { seedInput?: unknown },
  provision: typeof provisionConsumerInstallation = provisionConsumerInstallation,
): Promise<ConsumerInstallResult & { seed?: SeedSummary }> {
  if (options.seedInput === undefined) return provision(dependencies, options);
  const plan = planConsumerRuntimeSeed(options.seedInput);
  validateSeedScope(plan, options);
  const summary = {
    planHash: plan.planHash,
    recordCount: plan.records.length,
    agentId: plan.input.agent.id,
  };
  // This verifies the archive, runtime config, and current installation stage
  // before the foundation or seed changes customer resources.
  const preview = await provision(dependencies, { ...options, apply: false });
  if (!options.apply) return { ...preview, seed: { status: 'planned', ...summary } };

  const initialized = preview.manifest.stage.current === 'initialized';
  if (preview.manifest.stage.current === 'ready')
    throw new Error('Runtime seed cannot be added after the installation is ready');
  const foundation = initialized
    ? preview
    : await provision(dependencies, { ...options, runtime: undefined });
  if (foundation.manifest.stage.current !== 'provisioned' && !initialized)
    throw new Error('Runtime seed requires a provisioned customer foundation');

  const store = createInstallationStore({
    projectId: plan.input.projectId,
    installationId: plan.input.installationId,
    databaseId: preview.manifest.identity.databaseId,
  });
  let status: 'seeded' | 'already_seeded';
  try {
    if (initialized) {
      const marker = await store.doc('coordination', 'runtime-seed').get();
      if (!marker.exists)
        throw new Error('Initialized runtime has no seed marker; refusing late seed creation');
    }
    const result = await applyConsumerRuntimeSeed(store, plan);
    if (result.status !== 'seeded' && result.status !== 'already_seeded')
      throw new Error('Runtime seed returned an unexpected state');
    status = result.status;
  } finally {
    await store.db.terminate();
  }
  const result = options.runtime ? await provision(dependencies, options) : foundation;
  return { ...result, seed: { status, ...summary } };
}

/** Build customer-owned runtime images after the foundation has passed its read-only checks. */
export async function provisionConsumerInstallationWithPublishedImages(
  dependencies: ConsumerInstallDependencies,
  options: ConsumerInstallOptions & { seedInput?: unknown; runtimeConfig: unknown },
  provision: typeof provisionConsumerInstallation = provisionConsumerInstallation,
  publish: typeof publishConsumerImages = publishConsumerImages,
): Promise<ConsumerInstallResult & { imagePublish: unknown; seed?: SeedSummary }> {
  if (options.runtime) throw new Error('Use either --images or --build-images, not both');
  if (options.manifest.selection.modelProvider !== 'google')
    throw new Error('Building the customer runtime requires the Google model provider');
  if (options.seedInput !== undefined) {
    validateSeedScope(planConsumerRuntimeSeed(options.seedInput), {
      ...options,
      runtime: { images: {}, config: options.runtimeConfig },
    });
  }

  const sourceSha = options.manifest.identity.release.commitSha;
  const checkout = await dependencies.runner.run('git', ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (!checkout.ok || checkout.stdout !== sourceSha)
    throw new Error(
      '--build-images requires the installer checkout HEAD to match the manifest source commit',
    );
  const changes = await dependencies.runner.run('git', [
    'status',
    '--porcelain',
    '--untracked-files=no',
  ]);
  if (!changes.ok) throw new Error('Could not verify the installer checkout status');
  if (changes.stdout.length > 0)
    throw new Error('--build-images requires a clean tracked working tree');

  const foundation = await provision(dependencies, { ...options, apply: false });
  if (foundation.manifest.stage.current !== 'provisioned')
    throw new Error('--build-images requires an already provisioned customer foundation');

  const scratch = await mkdtemp(path.join(tmpdir(), 'assistant-consumer-install-'));
  const outputPath = path.join(scratch, 'image-manifest.json');
  try {
    const publishResult = await publish({
      projectId: options.manifest.identity.projectId,
      region: options.manifest.identity.region,
      repositoryId: options.manifest.identity.installationId,
      sourceSha,
      dryRun: !options.apply,
      ...(options.apply ? { outputPath } : {}),
    });
    if (!options.apply) return { ...foundation, imagePublish: publishResult };

    const images = JSON.parse(await readFile(outputPath, 'utf8')) as unknown;
    const result = await provisionConsumerInstallationWithSeed(
      dependencies,
      { ...options, runtime: { images, config: options.runtimeConfig } },
      provision,
    );
    return {
      ...result,
      imagePublish: {
        published: true,
        sourceSha,
      },
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function json(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error(`cannot read valid JSON from ${path}`);
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      archive: { type: 'string' },
      apply: { type: 'boolean' },
      'build-images': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      manifest: { type: 'string' },
      images: { type: 'string' },
      'runtime-config': { type: 'string' },
      'seed-plan': { type: 'string' },
      'owner-access-callback': { type: 'string' },
      state: { type: 'string' },
      'state-bucket': { type: 'string' },
      'terraform-dir': { type: 'string' },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(usage);
    return;
  }
  const required = [
    ['--manifest', values.manifest],
    ['--archive', values.archive],
    ['--state', values.state],
    ['--state-bucket', values['state-bucket']],
    ['--terraform-dir', values['terraform-dir']],
  ] as const;
  const missing = required.find(([, value]) => !value)?.[0];
  if (missing) throw new Error(`missing ${missing}\n\n${usage.trim()}`);
  if (Boolean(values.images) !== Boolean(values['runtime-config']))
    throw new Error('--images and --runtime-config must be supplied together');
  if (values['build-images'] && (!values['runtime-config'] || values.images))
    throw new Error(
      '--build-images requires --runtime-config and cannot be combined with --images',
    );
  if (values['build-images'] && values['owner-access-callback'])
    throw new Error('--build-images cannot be combined with --owner-access-callback');
  const options: ConsumerInstallOptions = {
    manifest: validateInstallationManifest(await json(values.manifest as string)),
    archivePath: values.archive as string,
    statePath: values.state as string,
    stateBucket: values['state-bucket'] as string,
    terraformDir: values['terraform-dir'] as string,
    apply: values.apply === true,
    runtime:
      values.images && values['runtime-config']
        ? { images: await json(values.images), config: await json(values['runtime-config']) }
        : undefined,
    ownerAccessCallback: values['owner-access-callback'],
  };
  const installDependencies = { runner: systemRunner };
  const installOptions = {
    ...options,
    seedInput: values['seed-plan'] ? await json(values['seed-plan']) : undefined,
  };
  const result = values['build-images']
    ? await provisionConsumerInstallationWithPublishedImages(installDependencies, {
        ...installOptions,
        runtimeConfig: await json(values['runtime-config'] as string),
      })
    : await provisionConsumerInstallationWithSeed(installDependencies, installOptions);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `consumer:install: ${error instanceof Error ? error.message : 'installation failed'}\n`,
    );
    process.exitCode = 1;
  }
}
