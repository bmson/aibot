/** Create-only seed for a fresh customer-owned minimal Firestore runtime. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  checkFirestoreRuntimeData,
  createInstallationStore,
  type InstallationStore,
} from '@assistant/firestore';
import type { EmbeddingSpace } from '@assistant/persistence';
import { Timestamp } from '@google-cloud/firestore';
import { z } from 'zod';
import { createGcloudAuthClient } from './gcloud-auth.js';

const ROLES = [
  'plan',
  'classify',
  'extract',
  'draft',
  'reason',
  'rewrite',
  'embed',
  'batch',
] as const;
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const INSTALLATION_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const VERTEX_MODEL_ID = /^vertex\/[A-Za-z0-9][A-Za-z0-9._@-]*$/;
const MONEY = /^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/;
// Marker versions track the create-only record set independently of the input format.
const SEED_MARKER_VERSION = 2;

const isoDate = z.string().refine((value) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}, 'expected an exact UTC ISO timestamp');
const pricingUrl = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
}, 'pricing source must be an HTTPS URL without credentials, query, or fragment');
const modelSchema = z.strictObject({
  id: z.string().regex(VERTEX_MODEL_ID),
  label: z.string().trim().min(1),
  capabilities: z.record(z.string(), z.boolean()),
  latencyClass: z.enum(['fast', 'medium', 'slow']),
  promptCostPerMTok: z.string().regex(MONEY),
  completionCostPerMTok: z.string().regex(MONEY),
  pricingSource: pricingUrl,
  pricingVerifiedAt: isoDate,
});
const roleSchema = z.strictObject({
  role: z.enum(ROLES),
  primaryModel: z.string().regex(VERTEX_MODEL_ID),
  fallbackModel: z.string().regex(VERTEX_MODEL_ID),
  params: z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean()])),
});
const inputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  projectId: z.string().regex(PROJECT_ID),
  installationId: z.string().regex(INSTALLATION_ID),
  seedAt: isoDate,
  agent: z.strictObject({
    id: z.uuid(),
    name: z.string().trim().min(1),
    email: z.email(),
    timezone: z.string().trim().min(1),
    locale: z.string().trim().min(2),
    signature: z.string(),
  }),
  budget: z.strictObject({
    dailyLimitMicros: z.number().int().positive().safe(),
    monthlyLimitMicros: z.number().int().positive().safe(),
    softPct: z.number().int().min(0).max(100),
  }),
  embeddingSpace: z.strictObject({
    provider: z.literal('vertex'),
    model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._@-]*$/),
    // The execution router and learned-skill recall currently share this width.
    dimensions: z.literal(1536),
    revision: z.string().trim().min(1),
  }),
  models: z.array(modelSchema).min(1).max(32),
  roles: z.array(roleSchema).length(ROLES.length),
});

export type ConsumerRuntimeSeedInput = z.infer<typeof inputSchema>;
type SeedRecord = { collection: string; id: string; data: Record<string, unknown> };
export interface ConsumerRuntimeSeedPlan {
  input: ConsumerRuntimeSeedInput;
  planHash: string;
  records: SeedRecord[];
}

function stable(value: unknown): unknown {
  if (value instanceof Date) return { $date: value.toISOString() };
  if (value instanceof Timestamp) return { $date: value.toDate().toISOString() };
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, field]) => [key, stable(field)]),
    );
  return value;
}

function canonical(value: unknown): string {
  return JSON.stringify(stable(value));
}

/** Pure, explicit plan. No credential, provider request, or Firestore client is used. */
export function planConsumerRuntimeSeed(value: unknown): ConsumerRuntimeSeedPlan {
  const input = inputSchema.parse(value);
  if (input.budget.monthlyLimitMicros < input.budget.dailyLimitMicros)
    throw new Error('monthly budget must be at least the daily budget');
  const models = [...input.models].sort((left, right) => left.id.localeCompare(right.id));
  const modelIds = new Set(models.map((model) => model.id));
  if (modelIds.size !== models.length) throw new Error('duplicate model ID');
  const roles = ROLES.map((role) => input.roles.find((entry) => entry.role === role));
  if (
    roles.some((role) => !role) ||
    new Set(input.roles.map((role) => role.role)).size !== ROLES.length
  )
    throw new Error('exactly one assignment is required for every model role');
  const usedModels = new Set<string>();
  for (const role of roles) {
    if (!role) throw new Error('missing model role');
    if (!modelIds.has(role.primaryModel) || !modelIds.has(role.fallbackModel))
      throw new Error(`role ${role.role} references a model outside the explicit catalog`);
    if (
      role.role !== 'embed' &&
      [role.primaryModel, role.fallbackModel].some(
        (id) => models.find((model) => model.id === id)?.capabilities.text !== true,
      )
    )
      throw new Error(`role ${role.role} requires text-capable primary and fallback models`);
    usedModels.add(role.primaryModel);
    usedModels.add(role.fallbackModel);
  }
  if (usedModels.size !== modelIds.size) throw new Error('unreferenced models cannot be enabled');
  const embedId = `vertex/${input.embeddingSpace.model}`;
  const embedRole = roles.find((role) => role?.role === 'embed');
  if (embedRole?.primaryModel !== embedId || embedRole.fallbackModel !== embedId)
    throw new Error('embed primary and fallback must match the declared embedding space');
  if (models.find((model) => model.id === embedId)?.capabilities.embedding !== true)
    throw new Error('embedding model must declare its embedding capability');
  for (const model of models) {
    if (new Date(model.pricingVerifiedAt) > new Date(input.seedAt))
      throw new Error('model pricing verification cannot postdate the seed timestamp');
    for (const price of [model.promptCostPerMTok, model.completionCostPerMTok]) {
      if (!Number.isFinite(Number(price)) || Number(price) > 1_000_000)
        throw new Error('model price is outside the supported USD per million-token range');
    }
  }

  const normalized: ConsumerRuntimeSeedInput = {
    ...input,
    models,
    roles: roles as ConsumerRuntimeSeedInput['roles'],
  };
  const planHash = createHash('sha256')
    .update(canonical({ recordSetVersion: SEED_MARKER_VERSION, input: normalized }))
    .digest('hex');
  const date = new Date(input.seedAt);
  const marker = { seedPlanHash: planHash };
  const agent = {
    id: input.agent.id,
    name: input.agent.name,
    email: input.agent.email,
    calendarId: null,
    phoneE164: null,
    avatarUrl: null,
    signature: input.agent.signature,
    timezone: input.agent.timezone,
    locale: input.agent.locale,
    workspacePrefix: `workspace/${input.installationId}`,
    browserProfilePath: null,
    credentialRefs: {},
    createdAt: date,
    updatedAt: date,
    ...marker,
  };
  const records: SeedRecord[] = [
    { collection: 'agents', id: input.agent.id, data: agent },
    { collection: 'coordination', id: 'budget-policy', data: { ...input.budget, ...marker } },
    // Direct chat uses this cap, and the owner can adjust it in Costs. Keep
    // the fresh-install default aligned with the chat fallback.
    {
      collection: 'budgets',
      id: 'task_default',
      data: { scope: 'task_default', limitUsd: '0.50', updatedAt: date, ...marker },
    },
    { collection: 'coordination', id: 'budget-holds', data: { heldMicros: 0, ...marker } },
    {
      collection: 'budgetPeriods',
      id: `day:${input.seedAt.slice(0, 10)}`,
      data: { spentMicros: 0, ...marker },
    },
    {
      collection: 'budgetPeriods',
      id: `month:${input.seedAt.slice(0, 7)}`,
      data: { spentMicros: 0, ...marker },
    },
    ...models.map((model) => ({
      collection: 'models',
      id: model.id,
      data: { ...model, enabled: true, createdAt: date, updatedAt: date, ...marker },
    })),
    ...roles.map((role) => {
      if (!role) throw new Error('missing model role');
      return {
        collection: 'modelRoles',
        id: role.role,
        data: { ...role, updatedAt: date, ...marker },
      };
    }),
  ];
  return { input: normalized, planHash, records };
}

function markerData(plan: ConsumerRuntimeSeedPlan) {
  return {
    schemaVersion: SEED_MARKER_VERSION,
    planHash: plan.planHash,
    projectId: plan.input.projectId,
    installationId: plan.input.installationId,
    agentId: plan.input.agent.id,
    embeddingSpace: plan.input.embeddingSpace,
    createdAt: new Date(plan.input.seedAt),
    status: 'in_progress',
  };
}

function markerMatches(value: unknown, plan: ConsumerRuntimeSeedPlan): boolean {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    row.schemaVersion === SEED_MARKER_VERSION &&
    row.planHash === plan.planHash &&
    row.projectId === plan.input.projectId &&
    row.installationId === plan.input.installationId &&
    row.agentId === plan.input.agent.id &&
    canonical(row.embeddingSpace) === canonical(plan.input.embeddingSpace) &&
    canonical(row.createdAt) === canonical(new Date(plan.input.seedAt)) &&
    (row.status === 'in_progress' || row.status === 'complete')
  );
}

const FRESH_COLLECTIONS = [
  'agents',
  'models',
  'modelRoles',
  'coordination',
  'budgets',
  'budgetPeriods',
  'tasks',
  'conversations',
  'contacts',
  'memories',
  'costEvents',
  'costReservations',
] as const;

async function beginSeed(
  store: InstallationStore,
  plan: ConsumerRuntimeSeedPlan,
): Promise<'new' | 'resume' | 'complete'> {
  return store.db.runTransaction(async (tx) => {
    const markerRef = store.doc('coordination', 'runtime-seed');
    const marker = await tx.get(markerRef);
    if (marker.exists) {
      if (!markerMatches(marker.data(), plan))
        throw new Error('runtime seed marker belongs to another plan');
      return marker.get('status') === 'complete' ? 'complete' : 'resume';
    }
    const existing = await Promise.all(
      FRESH_COLLECTIONS.map((collection) => tx.get(store.collection(collection).limit(1))),
    );
    if (existing.some((snapshot) => !snapshot.empty))
      throw new Error('installation already contains data; refusing to adopt foreign records');
    tx.create(markerRef, markerData(plan));
    return 'new';
  });
}

async function assertNoForeignSeedRecords(store: InstallationStore, plan: ConsumerRuntimeSeedPlan) {
  for (const collection of FRESH_COLLECTIONS) {
    const allowed = new Set(
      plan.records
        .filter((record) => record.collection === collection)
        .map((record) => store.doc(collection, record.id).id),
    );
    if (collection === 'coordination') allowed.add(store.doc('coordination', 'runtime-seed').id);
    const snapshot = await store.collection(collection).limit(65).get();
    if (snapshot.size === 65 || snapshot.docs.some((doc) => !allowed.has(doc.id)))
      throw new Error(`foreign ${collection} record exists during seed resume`);
  }
}

async function createMissing(
  store: InstallationStore,
  plan: ConsumerRuntimeSeedPlan,
  rows: SeedRecord[],
): Promise<number> {
  return store.db.runTransaction(async (tx) => {
    const marker = await tx.get(store.doc('coordination', 'runtime-seed'));
    if (
      !marker.exists ||
      !markerMatches(marker.data(), plan) ||
      marker.get('status') !== 'in_progress'
    )
      throw new Error('runtime seed marker changed');
    const refs = rows.map((row) => store.doc(row.collection, row.id));
    const snapshots = await tx.getAll(...refs);
    let created = 0;
    for (const [index, row] of rows.entries()) {
      const snapshot = snapshots[index];
      const ref = refs[index];
      if (!snapshot || !ref) throw new Error('incomplete runtime seed read');
      if (snapshot.exists) {
        const actual = snapshot.data();
        if (canonical(actual) !== canonical(row.data))
          throw new Error(`existing ${row.collection} record differs from this seed plan`);
      } else {
        tx.create(ref, row.data);
        created += 1;
      }
    }
    return created;
  });
}

export async function applyConsumerRuntimeSeed(
  store: InstallationStore,
  plan: ConsumerRuntimeSeedPlan,
) {
  if (store.projectId !== plan.input.projectId)
    throw new Error('seed project does not match the Firestore store');
  if (store.installationId !== plan.input.installationId)
    throw new Error('seed installation does not match the Firestore store');
  const state = await beginSeed(store, plan);
  let created = 0;
  if (state !== 'complete') {
    await assertNoForeignSeedRecords(store, plan);
    for (const collection of [
      'agents',
      'coordination',
      'budgets',
      'budgetPeriods',
      'models',
      'modelRoles',
    ]) {
      const rows = plan.records.filter((row) => row.collection === collection);
      if (rows.length) created += await createMissing(store, plan, rows);
    }
    await assertNoForeignSeedRecords(store, plan);
  }
  const embeddingSpace: EmbeddingSpace = plan.input.embeddingSpace;
  const preflight = await checkFirestoreRuntimeData(store, {
    agentId: plan.input.agent.id,
    provider: 'vertex',
    embeddingSpace,
  });
  if (!preflight.ready)
    throw new Error(
      `runtime seed did not pass preflight: ${preflight.issues.map((issue) => issue.code).join(', ')}`,
    );
  if (state !== 'complete') {
    await store.db.runTransaction(async (tx) => {
      const ref = store.doc('coordination', 'runtime-seed');
      const marker = await tx.get(ref);
      if (
        !marker.exists ||
        !markerMatches(marker.data(), plan) ||
        marker.get('status') !== 'in_progress'
      )
        throw new Error('runtime seed marker changed before completion');
      tx.update(ref, { status: 'complete', completedAt: store.now() });
    });
  }
  return {
    status: state === 'complete' ? 'already_seeded' : 'seeded',
    created,
    planHash: plan.planHash,
    preflight,
  };
}

const usage = `Usage: pnpm consumer:seed-runtime --input PLAN.json [--apply --project PROJECT --installation ID --database DATABASE] [--gcloud-auth]

Dry-run validates the exact customer plan without Google auth and prints no owner email or prices.
--apply is create-only: it refuses pre-existing foreign data and resumes only its own seed marker.
--gcloud-auth uses the active gcloud CLI account in memory; ADC remains the default.
`;

type RuntimeSeedCliDependencies = {
  createAuthClient?: typeof createGcloudAuthClient;
  createStore?: typeof createInstallationStore;
};

export async function runConsumerRuntimeSeedCli(
  argv: string[] = process.argv.slice(2),
  dependencies: RuntimeSeedCliDependencies = {},
) {
  const { values } = parseArgs({
    args: argv,
    options: {
      input: { type: 'string' },
      apply: { type: 'boolean' },
      project: { type: 'string' },
      installation: { type: 'string' },
      database: { type: 'string' },
      'gcloud-auth': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) return usage;
  if (!values.input) throw new Error(`missing --input\n\n${usage.trim()}`);
  let input: unknown;
  try {
    input = JSON.parse(await readFile(values.input, 'utf8'));
  } catch {
    throw new Error('input must be a readable JSON plan');
  }
  const plan = planConsumerRuntimeSeed(input);
  const summary = {
    projectId: plan.input.projectId,
    installationId: plan.input.installationId,
    agentId: plan.input.agent.id,
    planHash: plan.planHash,
    recordCount: plan.records.length,
    modelIds: plan.input.models.map((model) => model.id),
    embeddingSpace: plan.input.embeddingSpace,
  };
  if (!values.apply) return { dryRun: true, ...summary };
  if (values.project !== plan.input.projectId || values.installation !== plan.input.installationId)
    throw new Error('--project and --installation must explicitly match the input plan');
  if (!values.database || !/^\(default\)$|^[a-z][a-z0-9-]{2,61}[a-z0-9]$/.test(values.database))
    throw new Error('--database must explicitly select a valid Firestore database ID');
  const authClient = values['gcloud-auth']
    ? await (dependencies.createAuthClient ?? createGcloudAuthClient)()
    : undefined;
  const store = (dependencies.createStore ?? createInstallationStore)({
    projectId: plan.input.projectId,
    installationId: plan.input.installationId,
    databaseId: values.database,
    ...(authClient ? { authClient } : {}),
  });
  try {
    return { ...summary, ...(await applyConsumerRuntimeSeed(store, plan)) };
  } finally {
    await store.db.terminate();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runConsumerRuntimeSeedCli()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error: unknown) => {
      process.stderr.write(
        `consumer:seed-runtime: ${error instanceof Error ? error.message : 'seed failed'}\n`,
      );
      process.exitCode = 1;
    });
}
