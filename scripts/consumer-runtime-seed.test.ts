import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInstallationStore, FirestoreCostRepository } from '@assistant/firestore';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyConsumerRuntimeSeed,
  planConsumerRuntimeSeed,
  runConsumerRuntimeSeedCli,
} from './consumer-runtime-seed.js';

const agentId = '8202725c-1311-4eec-bddc-698c92db37d4';
const seedAt = '2026-09-22T12:00:00.000Z';
const source = 'https://example.test/synthetic-fixture-prices';

function fixture(installationId = `seed-${randomUUID()}`) {
  return {
    schemaVersion: 1,
    projectId: 'demo-assistant-test',
    installationId,
    seedAt,
    agent: {
      id: agentId,
      name: 'Fixture Assistant',
      email: 'owner@example.test',
      timezone: 'UTC',
      locale: 'en-US',
      signature: '',
    },
    budget: { dailyLimitMicros: 1_000_000, monthlyLimitMicros: 10_000_000, softPct: 80 },
    embeddingSpace: {
      provider: 'vertex',
      model: 'example-embedding',
      dimensions: 1536,
      revision: 'fixture-v1',
    },
    models: [
      {
        id: 'vertex/example-chat',
        label: 'Synthetic chat fixture',
        capabilities: { text: true },
        latencyClass: 'fast',
        promptCostPerMTok: '0.1',
        completionCostPerMTok: '0.2',
        pricingSource: source,
        pricingVerifiedAt: seedAt,
      },
      {
        id: 'vertex/example-embedding',
        label: 'Synthetic embedding fixture',
        capabilities: { embedding: true },
        latencyClass: 'fast',
        promptCostPerMTok: '0.01',
        completionCostPerMTok: '0',
        pricingSource: source,
        pricingVerifiedAt: seedAt,
      },
    ],
    roles: ['plan', 'classify', 'extract', 'draft', 'reason', 'rewrite', 'embed', 'batch'].map(
      (role) => ({
        role,
        primaryModel: role === 'embed' ? 'vertex/example-embedding' : 'vertex/example-chat',
        fallbackModel: role === 'embed' ? 'vertex/example-embedding' : 'vertex/example-chat',
        params: {},
      }),
    ),
  };
}

describe('consumer runtime seed plan', () => {
  it('requires explicit prices, provenance, complete routing, and matching embedding identity', () => {
    const input = fixture();
    const plan = planConsumerRuntimeSeed(input);
    expect(plan.records).toHaveLength(16);
    expect(plan.records.find((record) => record.collection === 'budgets')).toMatchObject({
      id: 'task_default',
      data: { scope: 'task_default', limitUsd: '0.50' },
    });
    expect(plan.records.find((record) => record.collection === 'models')?.data).toMatchObject({
      enabled: true,
      pricingSource: source,
      pricingVerifiedAt: seedAt,
    });
    expect(() =>
      planConsumerRuntimeSeed({
        ...input,
        models: input.models.map((model) => ({ ...model, pricingSource: undefined })),
      }),
    ).toThrow();
    expect(() => planConsumerRuntimeSeed({ ...input, roles: input.roles.slice(1) })).toThrow();
    expect(() =>
      planConsumerRuntimeSeed({
        ...input,
        embeddingSpace: { ...input.embeddingSpace, model: 'foreign-embedding' },
      }),
    ).toThrow();
    expect(() =>
      planConsumerRuntimeSeed({
        ...input,
        embeddingSpace: { ...input.embeddingSpace, dimensions: 768 },
      }),
    ).toThrow();
    expect(() =>
      planConsumerRuntimeSeed({
        ...input,
        models: input.models.map((model) => ({ ...model, promptCostPerMTok: '-1' })),
      }),
    ).toThrow();
    expect(() =>
      planConsumerRuntimeSeed({
        ...input,
        models: input.models.map((model) => ({
          ...model,
          capabilities: { embedding: true },
        })),
      }),
    ).toThrow('text-capable');
  });

  it('dry-runs without Google credentials or exposing owner email and prices', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'consumer-seed-'));
    const file = path.join(directory, 'plan.json');
    const previousCredentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    try {
      const input = fixture();
      await writeFile(file, JSON.stringify(input), 'utf8');
      process.env.GOOGLE_APPLICATION_CREDENTIALS = '/definitely/missing/customer-credentials.json';
      const result = await runConsumerRuntimeSeedCli(['--input', file]);
      expect(result).toMatchObject({ dryRun: true, recordCount: 16 });
      expect(JSON.stringify(result)).not.toContain('owner@example.test');
      expect(JSON.stringify(result)).not.toContain('promptCostPerMTok');
      await expect(runConsumerRuntimeSeedCli(['--input', file, '--apply'])).rejects.toThrow(
        'explicitly match',
      );
      await expect(
        runConsumerRuntimeSeedCli([
          '--input',
          file,
          '--apply',
          '--project',
          input.projectId,
          '--installation',
          input.installationId,
        ]),
      ).rejects.toThrow('--database');
    } finally {
      if (previousCredentials === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      else process.env.GOOGLE_APPLICATION_CREDENTIALS = previousCredentials;
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('consumer runtime seed emulator', () => {
  const stores: ReturnType<typeof createInstallationStore>[] = [];
  function storeFor(installationId: string) {
    const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
    stores.push(store);
    return store;
  }
  async function partialMarker(
    store: ReturnType<typeof createInstallationStore>,
    input: ReturnType<typeof fixture>,
  ) {
    const plan = planConsumerRuntimeSeed(input);
    await store.doc('coordination', 'runtime-seed').create({
      schemaVersion: 2,
      planHash: plan.planHash,
      projectId: input.projectId,
      installationId: input.installationId,
      agentId,
      embeddingSpace: input.embeddingSpace,
      createdAt: new Date(seedAt),
      status: 'in_progress',
    });
    return plan;
  }
  afterEach(async () => {
    for (const store of stores.splice(0)) {
      await store.db.recursiveDelete(store.root);
      await store.db.terminate();
    }
  });

  it('passes preflight, initializes zero budget counters, and reruns without writes while PostgreSQL is offline', async () => {
    const input = fixture();
    const store = storeFor(input.installationId);
    const plan = planConsumerRuntimeSeed(input);
    expect(await applyConsumerRuntimeSeed(store, plan)).toMatchObject({
      status: 'seeded',
      created: 16,
      preflight: { ready: true, issues: [] },
    });
    const cost = new FirestoreCostRepository(store);
    expect(await cost.totals()).toMatchObject({
      dailySpentUsd: 0,
      monthlySpentUsd: 0,
      heldUsd: 0,
      dailyLimitUsd: 1,
      monthlyLimitUsd: 10,
    });
    expect((await store.doc('budgets', 'task_default').get()).data()).toMatchObject({
      scope: 'task_default',
      limitUsd: '0.50',
      seedPlanHash: plan.planHash,
    });
    const firstMarker = await store.doc('coordination', 'runtime-seed').get();
    expect(firstMarker.get('status')).toBe('complete');
    expect(await applyConsumerRuntimeSeed(store, plan)).toMatchObject({
      status: 'already_seeded',
      created: 0,
      preflight: { ready: true, issues: [] },
    });
    const secondMarker = await store.doc('coordination', 'runtime-seed').get();
    expect(secondMarker.updateTime?.toMillis()).toBe(firstMarker.updateTime?.toMillis());
  });

  it('resumes only matching, unchanged records from its own incomplete marker', async () => {
    const input = fixture();
    const store = storeFor(input.installationId);
    const plan = await partialMarker(store, input);
    const agent = plan.records.find((record) => record.collection === 'agents');
    if (!agent) throw new Error('missing fixture agent');
    await store.doc(agent.collection, agent.id).create(agent.data);
    expect(await applyConsumerRuntimeSeed(store, plan)).toMatchObject({
      status: 'seeded',
      created: 15,
      preflight: { ready: true, issues: [] },
    });
    expect((await store.doc('agents', agentId).get()).get('name')).toBe('Fixture Assistant');
  });

  it('refuses a foreign owner without adopting it', async () => {
    const input = fixture();
    const store = storeFor(input.installationId);
    const plan = planConsumerRuntimeSeed(input);
    await store.doc('agents', agentId).create({ id: agentId, name: 'Foreign owner' });
    await expect(applyConsumerRuntimeSeed(store, plan)).rejects.toThrow(
      'refusing to adopt foreign records',
    );
    expect((await store.doc('coordination', 'runtime-seed').get()).exists).toBe(false);
  });

  it('refuses to adopt a pre-existing default task cap', async () => {
    const input = fixture();
    const store = storeFor(input.installationId);
    await store
      .doc('budgets', 'task_default')
      .create({ scope: 'task_default', limitUsd: '100.00' });
    await expect(applyConsumerRuntimeSeed(store, planConsumerRuntimeSeed(input))).rejects.toThrow(
      'refusing to adopt foreign records',
    );
    expect((await store.doc('coordination', 'runtime-seed').get()).exists).toBe(false);
  });

  it('refuses an older completed seed marker that predates the default task cap', async () => {
    const input = fixture();
    const store = storeFor(input.installationId);
    const plan = planConsumerRuntimeSeed(input);
    await store.doc('coordination', 'runtime-seed').create({
      schemaVersion: 1,
      planHash: plan.planHash,
      projectId: input.projectId,
      installationId: input.installationId,
      agentId,
      embeddingSpace: input.embeddingSpace,
      createdAt: new Date(seedAt),
      status: 'complete',
    });
    await expect(applyConsumerRuntimeSeed(store, plan)).rejects.toThrow(
      'runtime seed marker belongs to another plan',
    );
  });

  it('refuses changed seed records and foreign runtime data during partial resume', async () => {
    const input = fixture();
    const store = storeFor(input.installationId);
    await partialMarker(store, input);
    await store.doc('agents', agentId).create({ id: agentId, name: 'Foreign owner' });
    await expect(applyConsumerRuntimeSeed(store, planConsumerRuntimeSeed(input))).rejects.toThrow(
      'differs from this seed plan',
    );
    await store.doc('agents', agentId).delete();
    await store.doc('tasks', 'foreign-task').create({ status: 'queued' });
    await expect(applyConsumerRuntimeSeed(store, planConsumerRuntimeSeed(input))).rejects.toThrow(
      'foreign tasks record',
    );
    expect((await store.doc('models', 'vertex/example-chat').get()).exists).toBe(false);
  });

  it('refuses a different seed plan and does not rewrite its completed data', async () => {
    const input = fixture();
    const store = storeFor(input.installationId);
    const plan = planConsumerRuntimeSeed(input);
    await applyConsumerRuntimeSeed(store, plan);
    const changed = planConsumerRuntimeSeed({
      ...input,
      budget: { ...input.budget, dailyLimitMicros: 2_000_000 },
    });
    await expect(applyConsumerRuntimeSeed(store, changed)).rejects.toThrow(
      'belongs to another plan',
    );
    expect((await store.doc('coordination', 'budget-policy').get()).get('dailyLimitMicros')).toBe(
      1_000_000,
    );
  });
});
