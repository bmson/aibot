import { randomUUID } from 'node:crypto';
import { createInstallationStore } from '@assistant/firestore';
import {
  advanceInstallationStage,
  type ConsumerInstallOptions,
  type ConsumerInstallResult,
  createInstallationManifest,
  type InstallationManifest,
  type provisionConsumerInstallation,
} from '@assistant/setup/installation';
import { afterAll, describe, expect, it } from 'vitest';
import { provisionConsumerInstallationWithSeed } from './consumer-install.js';

const seedAt = '2026-09-22T12:00:00.000Z';
const agentId = '8202725c-1311-4eec-bddc-698c92db37d4';
const embeddingSpace = {
  provider: 'vertex',
  model: 'example-embedding',
  dimensions: 768,
  revision: 'fixture-v1',
};

function seedInput(installationId: string) {
  const chat = 'vertex/example-chat';
  const embed = 'vertex/example-embedding';
  const model = (id: string, capabilities: Record<string, boolean>) => ({
    id,
    label: `Synthetic ${id}`,
    capabilities,
    latencyClass: 'fast',
    promptCostPerMTok: '0.1',
    completionCostPerMTok: '0.2',
    pricingSource: 'https://example.test/synthetic-fixture-prices',
    pricingVerifiedAt: seedAt,
  });
  return {
    schemaVersion: 1,
    projectId: 'demo-assistant-test',
    installationId,
    seedAt,
    agent: {
      id: agentId,
      name: 'Fixture assistant',
      email: 'owner@example.test',
      timezone: 'UTC',
      locale: 'en-US',
      signature: '',
    },
    budget: { dailyLimitMicros: 1_000_000, monthlyLimitMicros: 10_000_000, softPct: 80 },
    embeddingSpace,
    models: [model(chat, { text: true }), model(embed, { embedding: true })],
    roles: ['plan', 'classify', 'extract', 'draft', 'reason', 'rewrite', 'embed', 'batch'].map(
      (role) => ({
        role,
        primaryModel: role === 'embed' ? embed : chat,
        fallbackModel: role === 'embed' ? embed : chat,
        params: {},
      }),
    ),
  };
}

function manifest(installationId: string) {
  return createInstallationManifest({
    identity: {
      installationId,
      projectId: 'demo-assistant-test',
      region: 'us-central1',
      databaseId: '(default)',
      release: {
        commitSha: '0123456789abcdef0123456789abcdef01234567',
        archiveDigest: `sha256:${'a'.repeat(64)}`,
      },
    },
    modules: [],
    modelProvider: 'google',
    embeddingModel: embeddingSpace.model,
    embeddingDimension: embeddingSpace.dimensions,
    resources: [],
    createdAt: seedAt,
  });
}

function advanced(input: InstallationManifest, to: 'provisioned' | 'initialized') {
  let result = input;
  for (const stage of ['authorized', 'bootstrapped', 'provisioned', 'initialized'] as const) {
    result = advanceInstallationStage(result, stage, seedAt);
    if (stage === to) break;
  }
  return result;
}

function installer(input: InstallationManifest, failRuntime = false) {
  let current = input;
  const calls: Array<{ apply: boolean; runtime: boolean }> = [];
  const provision: typeof provisionConsumerInstallation = async (_dependencies, options) => {
    calls.push({ apply: options.apply, runtime: Boolean(options.runtime) });
    if (options.apply && options.runtime) {
      if (failRuntime) throw new Error('runtime deployment failed');
      current = advanced(input, 'initialized');
    } else if (options.apply) {
      current = advanced(input, 'provisioned');
    }
    const result: ConsumerInstallResult = {
      manifest: current,
      applied: options.apply,
      runtimeReady: false,
      completed: current.stage.completed,
      pending: current.stage.current === 'initialized' ? ['ready'] : ['initialized', 'ready'],
      note: 'fixture',
    };
    return result;
  };
  return {
    calls,
    provision,
    current: () => current,
    failRuntime: () => {
      failRuntime = false;
    },
  };
}

const dependencies = {
  runner: {
    run: async () => {
      throw new Error('unexpected cloud command');
    },
  },
};

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'consumer install runtime seed orchestration',
  () => {
    const stores: ReturnType<typeof createInstallationStore>[] = [];
    function setup() {
      const installationId = `seed-${randomUUID().slice(0, 8)}`;
      const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
      stores.push(store);
      const input = manifest(installationId);
      const options: ConsumerInstallOptions & { seedInput: unknown } = {
        manifest: input,
        archivePath: 'unused',
        statePath: 'unused',
        stateBucket: 'unused',
        terraformDir: 'unused',
        apply: true,
        seedInput: seedInput(installationId),
      };
      return { store, options, input };
    }
    afterAll(async () => {
      for (const store of stores) {
        await store.db.recursiveDelete(store.root);
        await store.db.terminate();
      }
    });

    it('previews without creating a marker or invoking apply', async () => {
      const { store, options, input } = setup();
      const stub = installer(input);
      const result = await provisionConsumerInstallationWithSeed(
        dependencies,
        { ...options, apply: false },
        stub.provision,
      );
      expect(result.seed).toMatchObject({ status: 'planned', agentId });
      expect(stub.calls).toEqual([{ apply: false, runtime: false }]);
      expect((await store.doc('coordination', 'runtime-seed').get()).exists).toBe(false);
      expect(JSON.stringify(result)).not.toContain('owner@example.test');
      expect(JSON.stringify(result)).not.toContain('promptCostPerMTok');
    });

    it('applies a create-only seed after foundation provisioning', async () => {
      const { store, options, input } = setup();
      const stub = installer(input);
      const result = await provisionConsumerInstallationWithSeed(
        dependencies,
        options,
        stub.provision,
      );
      expect(result.manifest.stage.current).toBe('provisioned');
      expect(result.seed).toMatchObject({ status: 'seeded', agentId });
      expect(stub.calls).toEqual([
        { apply: false, runtime: false },
        { apply: true, runtime: false },
      ]);
      expect((await store.doc('coordination', 'runtime-seed').get()).get('status')).toBe(
        'complete',
      );
    });

    it('seeds before optional runtime deployment, then retries without rewriting records', async () => {
      const { store, options, input } = setup();
      const stub = installer(input, true);
      const runtime = {
        images: {},
        config: {
          firestoreAgentId: agentId,
          ownerEmail: 'owner@example.test',
          firestoreEmbeddingSpace: embeddingSpace,
        },
      };
      await expect(
        provisionConsumerInstallationWithSeed(
          dependencies,
          { ...options, runtime },
          stub.provision,
        ),
      ).rejects.toThrow('runtime deployment failed');
      expect((await store.doc('coordination', 'runtime-seed').get()).get('status')).toBe(
        'complete',
      );
      expect(stub.calls).toEqual([
        { apply: false, runtime: true },
        { apply: true, runtime: false },
        { apply: true, runtime: true },
      ]);
      stub.failRuntime();
      const result = await provisionConsumerInstallationWithSeed(
        dependencies,
        { ...options, runtime },
        stub.provision,
      );
      expect(result.seed?.status).toBe('already_seeded');
      expect(result.manifest.stage.current).toBe('initialized');
      expect((await store.doc('agents', agentId).get()).exists).toBe(true);
    });

    it('rejects identity, embedding, provider, and runtime mismatch before any apply', async () => {
      const { options, input } = setup();
      const stub = installer(input);
      const plan = options.seedInput as ReturnType<typeof seedInput>;
      for (const seedInput of [
        { ...plan, projectId: 'foreign-project' },
        { ...plan, embeddingSpace: { ...embeddingSpace, dimensions: 1024 } },
      ]) {
        await expect(
          provisionConsumerInstallationWithSeed(
            dependencies,
            { ...options, seedInput },
            stub.provision,
          ),
        ).rejects.toThrow();
      }
      await expect(
        provisionConsumerInstallationWithSeed(
          dependencies,
          {
            ...options,
            manifest: { ...input, selection: { ...input.selection, modelProvider: 'openrouter' } },
          },
          stub.provision,
        ),
      ).rejects.toThrow('Google provider');
      await expect(
        provisionConsumerInstallationWithSeed(
          dependencies,
          { ...options, runtime: { images: {}, config: { firestoreAgentId: randomUUID() } } },
          stub.provision,
        ),
      ).rejects.toThrow('differs from seed plan');
      expect(stub.calls).toEqual([]);
    });

    it('leaves the foundation resumable when seed refuses existing data', async () => {
      const { store, options, input } = setup();
      const stub = installer(input);
      await store.doc('agents', 'foreign-agent').create({ id: 'foreign-agent' });
      await expect(
        provisionConsumerInstallationWithSeed(dependencies, options, stub.provision),
      ).rejects.toThrow('installation already contains data');
      expect(stub.current().stage.current).toBe('provisioned');
      expect(stub.calls).toEqual([
        { apply: false, runtime: false },
        { apply: true, runtime: false },
      ]);
      expect((await store.doc('coordination', 'runtime-seed').get()).exists).toBe(false);
    });

    it('refuses late seed creation after runtime initialization without a marker', async () => {
      const { store, options, input } = setup();
      const stub = installer(input);
      const runtime = {
        images: {},
        config: {
          firestoreAgentId: agentId,
          ownerEmail: 'owner@example.test',
          firestoreEmbeddingSpace: embeddingSpace,
        },
      };
      await stub.provision(dependencies, { ...options, runtime });
      await expect(
        provisionConsumerInstallationWithSeed(
          dependencies,
          { ...options, runtime },
          stub.provision,
        ),
      ).rejects.toThrow('no seed marker');
      expect((await store.doc('coordination', 'runtime-seed').get()).exists).toBe(false);
    });

    it('retains the original installer path without a seed plan', async () => {
      const { options, input } = setup();
      const stub = installer(input);
      const result = await provisionConsumerInstallationWithSeed(
        dependencies,
        { ...options, seedInput: undefined },
        stub.provision,
      );
      expect(result.seed).toBeUndefined();
      expect(stub.calls).toEqual([{ apply: true, runtime: false }]);
    });
  },
);
