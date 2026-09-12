import type { AssistantModule } from '@assistant/config';
import { assistantModuleMetas } from '@assistant/modules/installation-meta';

export const INSTALLATION_MANIFEST_KIND = 'assistant-installation' as const;
export const INSTALLATION_MANIFEST_SCHEMA_VERSION = 1 as const;

export const installationStages = [
  'previewed',
  'authorized',
  'bootstrapped',
  'provisioned',
  'initialized',
  'ready',
] as const;

export type InstallationStage = (typeof installationStages)[number];
export type InstallationResourceOwner = 'bootstrap' | 'terraform' | 'preexisting';
export type InstallationResourceScope = 'installation' | 'project' | 'global';

export interface InstallationIdentity {
  installationId: string;
  projectId: string;
  region: string;
  databaseId: string;
  release: {
    commitSha: string;
    archiveDigest: string;
  };
}

export interface InstallationResource {
  kind: string;
  name: string;
  scope: InstallationResourceScope;
  owner: InstallationResourceOwner;
  /** Null means this is an existing resource the installer does not own. */
  installationId: string | null;
}

export interface InstallationSelection {
  profile: 'firestore';
  modules: readonly AssistantModule[];
  modelProvider: 'google' | 'openrouter';
  embeddingModel?: string;
  embeddingDimension?: number;
}

export interface InstallationStageState {
  current: InstallationStage;
  completed: readonly InstallationStage[];
  updatedAt: string;
}

export interface InstallationManifest {
  kind: typeof INSTALLATION_MANIFEST_KIND;
  schemaVersion: typeof INSTALLATION_MANIFEST_SCHEMA_VERSION;
  identity: InstallationIdentity;
  selection: InstallationSelection;
  resources: readonly InstallationResource[];
  status: 'active' | 'invalidated';
  stage: InstallationStageState;
  invalidation?: {
    reason: string;
    at: string;
  };
}

export interface CreateInstallationManifestInput {
  identity: InstallationIdentity;
  modules: readonly string[];
  modelProvider: InstallationSelection['modelProvider'];
  embeddingModel?: string;
  embeddingDimension?: number;
  resources: readonly InstallationResource[];
  createdAt: string;
}

const moduleOrder = new Map(assistantModuleMetas.map((meta, index) => [meta.name, index] as const));
const knownModules = new Set(moduleOrder.keys());
const idPattern = /^[a-z][a-z0-9-]{2,19}[a-z0-9]$/;
const projectPattern = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const regionPattern = /^[a-z][a-z0-9-]+[0-9]$/;
const databasePattern =
  /^(?![0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$)[a-z][a-z0-9-]{2,61}[a-z0-9]$/;
const shaPattern = /^[0-9a-f]{40}$/i;
const digestPattern = /^sha256:[0-9a-f]{64}$/i;
const resourceKindPattern = /^[a-z][a-z0-9._-]{0,62}$/;
const timestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;

function fail(path: string, message: string): never {
  throw new Error(`Invalid installation manifest ${path}: ${message}`);
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(path, 'must be a non-empty string');
  return value;
}

function assertKnownKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(path, `unknown field ${key}`);
  }
}

function timestampAt(value: unknown, path: string): string {
  const timestamp = stringAt(value, path);
  const match = timestampPattern.exec(timestamp);
  if (!match || !Number.isFinite(Date.parse(timestamp))) {
    fail(path, 'must be an ISO UTC timestamp');
  }
  const parsed = new Date(Date.parse(timestamp));
  const [, year, month, day, hour, minute, second, millisecond = '0'] = match;
  if (
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() + 1 !== Number(month) ||
    parsed.getUTCDate() !== Number(day) ||
    parsed.getUTCHours() !== Number(hour) ||
    parsed.getUTCMinutes() !== Number(minute) ||
    parsed.getUTCSeconds() !== Number(second) ||
    parsed.getUTCMilliseconds() !== Number(millisecond)
  ) {
    fail(path, 'must be a real calendar date');
  }
  return timestamp;
}

function assertTimestampNotBefore(now: string, previous: string, path: string): void {
  if (Date.parse(now) < Date.parse(previous)) {
    fail(path, `must not be earlier than ${previous}`);
  }
}

function assertResourceName(name: string, path: string): void {
  if (
    name.length < 1 ||
    name.length > 255 ||
    [...name].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    fail(path, 'has invalid characters');
  }
}

function canonicalIdentity(value: unknown): InstallationIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('identity', 'must be an object');
  const input = value as Record<string, unknown>;
  assertKnownKeys(
    input,
    ['installationId', 'projectId', 'region', 'databaseId', 'release'],
    'identity',
  );
  const installationId = stringAt(input.installationId, 'identity.installationId').toLowerCase();
  const projectId = stringAt(input.projectId, 'identity.projectId').toLowerCase();
  const region = stringAt(input.region, 'identity.region').toLowerCase();
  const databaseId = stringAt(input.databaseId, 'identity.databaseId');
  if (!idPattern.test(installationId)) fail('identity.installationId', 'has invalid format');
  if (!projectPattern.test(projectId)) fail('identity.projectId', 'has invalid format');
  if (!regionPattern.test(region)) fail('identity.region', 'has invalid format');
  if (!databasePattern.test(databaseId)) fail('identity.databaseId', 'has invalid format');

  if (!input.release || typeof input.release !== 'object' || Array.isArray(input.release)) {
    fail('identity.release', 'must be an object');
  }
  const release = input.release as Record<string, unknown>;
  assertKnownKeys(release, ['commitSha', 'archiveDigest'], 'identity.release');
  const commitSha = stringAt(release.commitSha, 'identity.release.commitSha').toLowerCase();
  const archiveDigest = stringAt(
    release.archiveDigest,
    'identity.release.archiveDigest',
  ).toLowerCase();
  if (!shaPattern.test(commitSha))
    fail('identity.release.commitSha', 'must be a full 40-character SHA');
  if (!digestPattern.test(archiveDigest))
    fail('identity.release.archiveDigest', 'must be sha256:<64 hex characters>');
  return { installationId, projectId, region, databaseId, release: { commitSha, archiveDigest } };
}

function canonicalInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('input', 'must be an object');
  }
  const input = value as Record<string, unknown>;
  assertKnownKeys(
    input,
    [
      'identity',
      'modules',
      'modelProvider',
      'embeddingModel',
      'embeddingDimension',
      'resources',
      'createdAt',
    ],
    'input',
  );
  return input;
}

function canonicalModules(value: unknown): AssistantModule[] {
  if (!Array.isArray(value)) fail('selection.modules', 'must be an array');
  const modules: AssistantModule[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || !knownModules.has(item as AssistantModule))
      fail('selection.modules', `unsupported module ${String(item)}`);
    const module = item as AssistantModule;
    if (seen.has(module)) fail('selection.modules', `duplicate module ${module}`);
    seen.add(module);
    modules.push(module);
  }
  return modules.sort((a, b) => (moduleOrder.get(a) ?? 0) - (moduleOrder.get(b) ?? 0));
}

function canonicalResources(
  value: unknown,
  installationId: string,
  projectId: string,
): InstallationResource[] {
  if (!Array.isArray(value)) fail('resources', 'must be an array');
  const seen = new Set<string>();
  const resources = value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      fail(`resources[${index}]`, 'must be an object');
    const input = item as Record<string, unknown>;
    assertKnownKeys(
      input,
      ['kind', 'name', 'scope', 'owner', 'installationId'],
      `resources[${index}]`,
    );
    const kind = stringAt(input.kind, `resources[${index}].kind`).toLowerCase();
    const name = stringAt(input.name, `resources[${index}].name`);
    const scope = input.scope;
    const owner = input.owner;
    const resourceInstallationId = input.installationId;
    if (!resourceKindPattern.test(kind)) fail(`resources[${index}].kind`, 'has invalid format');
    assertResourceName(name, `resources[${index}].name`);
    if (scope !== 'installation' && scope !== 'project' && scope !== 'global')
      fail(`resources[${index}].scope`, 'is invalid');
    if (owner !== 'bootstrap' && owner !== 'terraform' && owner !== 'preexisting')
      fail(`resources[${index}].owner`, 'is invalid');
    if (owner === 'preexisting') {
      if (resourceInstallationId !== null)
        fail(`resources[${index}].installationId`, 'must be null for preexisting resources');
    } else if (resourceInstallationId !== installationId) {
      fail(`resources[${index}].installationId`, 'must match the manifest installation');
    }
    if (owner !== 'preexisting') {
      const projectReference = /(?:^|\/)projects\/([^/]+)(?:\/|$)/.exec(name)?.[1];
      if (projectReference && projectReference !== projectId) {
        fail(`resources[${index}].name`, 'references a different project');
      }
    }
    const key = `${kind}:${name}`;
    if (seen.has(key)) fail(`resources[${index}]`, `duplicate resource identity ${key}`);
    seen.add(key);
    return {
      kind,
      name,
      scope,
      owner,
      installationId: resourceInstallationId,
    } as InstallationResource;
  });
  return resources.sort((a, b) =>
    `${a.scope}:${a.kind}:${a.name}`.localeCompare(`${b.scope}:${b.kind}:${b.name}`),
  );
}

function canonicalSelection(input: Record<string, unknown>): InstallationSelection {
  assertKnownKeys(
    input,
    ['profile', 'modules', 'modelProvider', 'embeddingModel', 'embeddingDimension'],
    'selection',
  );
  if (input.profile !== 'firestore') fail('selection.profile', 'must be firestore');
  const modelProvider = input.modelProvider;
  if (modelProvider !== 'google' && modelProvider !== 'openrouter')
    fail('selection.modelProvider', 'is invalid');
  const selection: InstallationSelection = {
    profile: 'firestore',
    modules: canonicalModules(input.modules),
    modelProvider,
  };
  if (input.embeddingModel !== undefined) {
    const embeddingModel = stringAt(input.embeddingModel, 'selection.embeddingModel');
    selection.embeddingModel = embeddingModel;
  }
  if (input.embeddingDimension !== undefined) {
    const embeddingDimension = input.embeddingDimension;
    if (
      typeof embeddingDimension !== 'number' ||
      !Number.isInteger(embeddingDimension) ||
      embeddingDimension < 1 ||
      embeddingDimension > 2048
    ) {
      fail('selection.embeddingDimension', 'must be an integer from 1 through 2048');
    }
    selection.embeddingDimension = embeddingDimension;
  }
  return selection;
}

function validateStageState(value: unknown): InstallationStageState {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('stage', 'must be an object');
  const input = value as Record<string, unknown>;
  assertKnownKeys(input, ['current', 'completed', 'updatedAt'], 'stage');
  const current = input.current;
  const completed = input.completed;
  if (!installationStages.includes(current as InstallationStage))
    fail('stage.current', 'is invalid');
  if (!Array.isArray(completed)) fail('stage.completed', 'must be an array');
  const index = installationStages.indexOf(current as InstallationStage);
  if (
    completed.length !== index + 1 ||
    completed.some((stage, i) => stage !== installationStages[i])
  ) {
    fail('stage.completed', 'must be the ordered prefix ending at current');
  }
  return {
    current: current as InstallationStage,
    completed: [...completed] as InstallationStage[],
    updatedAt: timestampAt(input.updatedAt, 'stage.updatedAt'),
  };
}

export function createInstallationManifest(
  input: CreateInstallationManifestInput,
): InstallationManifest {
  const rawInput = canonicalInput(input);
  const identity = canonicalIdentity(rawInput.identity);
  const selection = canonicalSelection({
    profile: 'firestore',
    modules: rawInput.modules,
    modelProvider: rawInput.modelProvider,
    ...(rawInput.embeddingModel === undefined ? {} : { embeddingModel: rawInput.embeddingModel }),
    ...(rawInput.embeddingDimension === undefined
      ? {}
      : { embeddingDimension: rawInput.embeddingDimension }),
  });
  const createdAt = timestampAt(rawInput.createdAt, 'stage.updatedAt');
  return {
    kind: INSTALLATION_MANIFEST_KIND,
    schemaVersion: INSTALLATION_MANIFEST_SCHEMA_VERSION,
    identity,
    selection,
    resources: canonicalResources(rawInput.resources, identity.installationId, identity.projectId),
    status: 'active',
    stage: { current: 'previewed', completed: ['previewed'], updatedAt: createdAt },
  };
}

export function validateInstallationManifest(value: unknown): InstallationManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('manifest', 'must be an object');
  const input = value as Record<string, unknown>;
  assertKnownKeys(
    input,
    [
      'kind',
      'schemaVersion',
      'identity',
      'selection',
      'resources',
      'status',
      'stage',
      'invalidation',
    ],
    'manifest',
  );
  if (input.kind !== INSTALLATION_MANIFEST_KIND) fail('kind', 'is unsupported');
  if (input.schemaVersion !== INSTALLATION_MANIFEST_SCHEMA_VERSION)
    fail('schemaVersion', 'is unsupported');
  const identity = canonicalIdentity(input.identity);
  if (!input.selection || typeof input.selection !== 'object' || Array.isArray(input.selection))
    fail('selection', 'must be an object');
  const selection = canonicalSelection(input.selection as Record<string, unknown>);
  const resources = canonicalResources(
    input.resources,
    identity.installationId,
    identity.projectId,
  );
  const stage = validateStageState(input.stage);
  if (input.status !== 'active' && input.status !== 'invalidated') fail('status', 'is invalid');
  if (input.status === 'active' && input.invalidation !== undefined)
    fail('invalidation', 'is only allowed for invalidated manifests');
  let invalidation: InstallationManifest['invalidation'];
  if (input.status === 'invalidated') {
    if (
      !input.invalidation ||
      typeof input.invalidation !== 'object' ||
      Array.isArray(input.invalidation)
    )
      fail('invalidation', 'is required');
    const data = input.invalidation as Record<string, unknown>;
    assertKnownKeys(data, ['reason', 'at'], 'invalidation');
    invalidation = {
      reason: stringAt(data.reason, 'invalidation.reason'),
      at: timestampAt(data.at, 'invalidation.at'),
    };
    assertTimestampNotBefore(invalidation.at, stage.updatedAt, 'invalidation.at');
  }
  return {
    kind: INSTALLATION_MANIFEST_KIND,
    schemaVersion: INSTALLATION_MANIFEST_SCHEMA_VERSION,
    identity,
    selection,
    resources,
    status: input.status,
    stage,
    ...(invalidation ? { invalidation } : {}),
  };
}

export function serializeInstallationManifest(manifest: InstallationManifest): string {
  return JSON.stringify(validateInstallationManifest(manifest));
}

function sameIdentity(a: InstallationIdentity, b: InstallationIdentity): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function advanceInstallationStage(
  manifest: InstallationManifest,
  next: InstallationStage,
  now: string,
): InstallationManifest {
  const current = validateInstallationManifest(manifest);
  if (current.status === 'invalidated')
    throw new Error('Cannot advance an invalidated installation');
  const nextTimestamp = timestampAt(now, 'stage.updatedAt');
  assertTimestampNotBefore(nextTimestamp, current.stage.updatedAt, 'stage.updatedAt');
  if (next === current.stage.current) return current;
  const currentIndex = installationStages.indexOf(current.stage.current);
  if (installationStages.indexOf(next) !== currentIndex + 1) {
    throw new Error(
      `Installation stage must advance from ${current.stage.current} to its immediate successor`,
    );
  }
  return validateInstallationManifest({
    ...current,
    stage: {
      current: next,
      completed: [...current.stage.completed, next],
      updatedAt: nextTimestamp,
    },
  });
}

export function resumeInstallation(
  manifest: InstallationManifest,
  expectedIdentity: InstallationIdentity,
  now: string,
): InstallationManifest {
  const current = validateInstallationManifest(manifest);
  const identity = canonicalIdentity(expectedIdentity);
  const invalidationTimestamp = timestampAt(now, 'invalidation.at');
  assertTimestampNotBefore(invalidationTimestamp, current.stage.updatedAt, 'invalidation.at');
  if (current.invalidation) {
    assertTimestampNotBefore(invalidationTimestamp, current.invalidation.at, 'invalidation.at');
  }
  if (current.status === 'invalidated' || sameIdentity(current.identity, identity)) return current;
  return validateInstallationManifest({
    ...current,
    status: 'invalidated',
    invalidation: { reason: 'immutable installation identity changed', at: invalidationTimestamp },
  });
}
