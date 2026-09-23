import type { InstallationIdentity } from './installation-manifest.js';
import type { CommandRunner } from './runner.js';

type IndexField = {
  fieldPath: string;
  order?: string;
  arrayConfig?: string;
  vectorConfig?: { dimension: number; flat: Record<string, never> };
};

type Index = { collectionGroup: string; queryScope: string; fields: IndexField[] };
type FieldOverride = { collectionGroup: string; fieldPath: string; indexes: unknown[] };
type IndexSpec = { indexes: Index[]; fieldOverrides: FieldOverride[] };

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} is malformed`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${label} is malformed`);
  return value;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} is malformed`);
  return value;
}

function canonicalField(raw: unknown): IndexField {
  const value = object(raw, 'Firestore index field');
  const fieldPath = string(value.fieldPath, 'Firestore index field path');
  const modes = ['order', 'arrayConfig', 'vectorConfig'].filter((key) => value[key] !== undefined);
  if (modes.length !== 1) throw new Error(`Firestore index field ${fieldPath} has invalid mode`);
  if (value.order !== undefined) {
    if (value.order !== 'ASCENDING' && value.order !== 'DESCENDING')
      throw new Error(`Firestore index field ${fieldPath} has invalid order`);
    return { fieldPath, order: value.order };
  }
  if (value.arrayConfig !== undefined) {
    if (value.arrayConfig !== 'CONTAINS')
      throw new Error(`Firestore index field ${fieldPath} has invalid array mode`);
    return { fieldPath, arrayConfig: value.arrayConfig };
  }
  const vector = object(value.vectorConfig, `Firestore index field ${fieldPath} vector`);
  if (!Number.isSafeInteger(vector.dimension) || (vector.dimension as number) <= 0)
    throw new Error(`Firestore index field ${fieldPath} has invalid vector dimension`);
  const flat = object(vector.flat, `Firestore index field ${fieldPath} flat vector`);
  if (Object.keys(flat).length !== 0)
    throw new Error(`Firestore index field ${fieldPath} has unknown flat vector settings`);
  return { fieldPath, vectorConfig: { dimension: vector.dimension as number, flat: {} } };
}

function canonicalIndex(raw: unknown, prefix: string, trusted: boolean): Index {
  const value = object(raw, 'Firestore composite index');
  let collectionGroup: string;
  if (trusted) {
    collectionGroup = string(value.collectionGroup, 'Trusted index collection group');
  } else {
    const name = string(value.name, 'Firestore composite index name');
    if (!name.startsWith(prefix)) throw new Error(`Foreign Firestore index ${name}`);
    const suffix = name.slice(prefix.length);
    const match = /^([^/]+)\/indexes\/([^/]+)$/.exec(suffix);
    if (!match?.[1] || !match[2]) throw new Error(`Ambiguous Firestore index name ${name}`);
    collectionGroup = match[1];
    if (value.state !== 'READY')
      throw new Error(`Firestore index ${name} is ${String(value.state ?? 'not READY')}`);
  }
  const queryScope = string(value.queryScope, 'Firestore index query scope');
  if (queryScope !== 'COLLECTION' && queryScope !== 'COLLECTION_GROUP')
    throw new Error('Firestore index query scope is invalid');
  const fields = array(value.fields, 'Firestore index fields').map(canonicalField);
  if (fields.length < 2) throw new Error('Firestore composite index has too few fields');
  if (trusted) {
    if (fields.some((field) => field.fieldPath === '__name__'))
      throw new Error('Trusted index unexpectedly declares __name__');
    const last = fields.at(-1);
    fields.push({
      fieldPath: '__name__',
      order: last?.order === 'DESCENDING' ? 'DESCENDING' : 'ASCENDING',
    });
  }
  return { collectionGroup, queryScope, fields };
}

function indexKey(index: Index): string {
  return JSON.stringify([index.collectionGroup, index.queryScope, index.fields]);
}

function fieldKey(collectionGroup: string, fieldPath: string): string {
  return JSON.stringify([collectionGroup, fieldPath]);
}

function exactlyExpected(expected: string[], actual: string[], kind: string): void {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  if (expectedSet.size !== expected.length || actualSet.size !== actual.length)
    throw new Error(`Duplicate ${kind} identity`);
  if (expectedSet.size !== actualSet.size || expected.some((key) => !actualSet.has(key)))
    throw new Error(`${kind} differ from the trusted installation manifest`);
}

async function list(runner: CommandRunner, args: string[], label: string): Promise<unknown[]> {
  const result = await runner.run('gcloud', args);
  if (!result.ok) throw new Error(`${label} read failed: ${result.stderr || 'unknown error'}`);
  try {
    return array(JSON.parse(result.stdout), `${label} response`);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} returned invalid JSON`);
    throw error;
  }
}

/** Read only: do not persist `provisioned` until every trusted index is READY. */
export async function verifyConsumerIndexReadiness(
  runner: CommandRunner,
  identity: InstallationIdentity,
  verifiedSpec: Buffer,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(verifiedSpec.toString('utf8'));
  } catch {
    throw new Error('Trusted Firestore index manifest is invalid JSON');
  }
  const spec = object(parsed, 'Trusted Firestore index manifest') as IndexSpec;
  const expectedIndexes = array(spec.indexes, 'Trusted Firestore indexes').map((index) =>
    canonicalIndex(index, '', true),
  );
  const expectedFields = array(spec.fieldOverrides, 'Trusted Firestore field overrides').map(
    (raw) => {
      const field = object(raw, 'Trusted Firestore field override');
      if (array(field.indexes, 'Trusted Firestore field indexes').length !== 0)
        throw new Error('Trusted Firestore field override contains unsupported indexes');
      return fieldKey(
        string(field.collectionGroup, 'Trusted field collection group'),
        string(field.fieldPath, 'Trusted field path'),
      );
    },
  );
  const prefix = `projects/${identity.projectId}/databases/${identity.databaseId}/collectionGroups/`;
  const flags = [
    `--project=${identity.projectId}`,
    `--database=${identity.databaseId}`,
    '--format=json',
  ];
  const [composites, overrides] = await Promise.all([
    list(runner, ['firestore', 'indexes', 'composite', 'list', ...flags], 'Composite indexes'),
    list(runner, ['firestore', 'indexes', 'fields', 'list', ...flags], 'Field overrides'),
  ]);
  exactlyExpected(
    expectedIndexes.map(indexKey),
    composites.map((index) => indexKey(canonicalIndex(index, prefix, false))),
    'Firestore composite indexes',
  );
  let defaultFields = 0;
  const actualFields = overrides.flatMap((raw) => {
    const field = object(raw, 'Firestore field override');
    const name = string(field.name, 'Firestore field name');
    if (name === `${prefix}__default__/fields/*`) {
      defaultFields++;
      if (defaultFields > 1) throw new Error('Duplicate Firestore default field configuration');
      return [];
    }
    if (!name.startsWith(prefix)) throw new Error(`Foreign Firestore field override ${name}`);
    const match = /^([^/]+)\/fields\/([^/]+)$/.exec(name.slice(prefix.length));
    if (!match?.[1] || !match[2]) throw new Error(`Ambiguous Firestore field override ${name}`);
    const indexConfig = object(field.indexConfig, `Firestore field override ${name} config`);
    if (
      (indexConfig.usesAncestorConfig !== undefined && indexConfig.usesAncestorConfig !== false) ||
      (indexConfig.reverting !== undefined && indexConfig.reverting !== false) ||
      (indexConfig.indexes !== undefined &&
        array(indexConfig.indexes, `Firestore field override ${name} indexes`).length !== 0) ||
      field.ttlConfig !== undefined
    )
      throw new Error(`Firestore field override ${name} is not an active exemption`);
    return [fieldKey(match[1], match[2])];
  });
  exactlyExpected(expectedFields, actualFields, 'Firestore field overrides');
}
