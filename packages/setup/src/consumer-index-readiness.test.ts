import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  provisionTargetFirestoreIndexes,
  verifyConsumerIndexReadiness,
} from './consumer-index-readiness.js';
import type { InstallationIdentity } from './installation-manifest.js';
import type { CommandRunner } from './runner.js';

const identity: InstallationIdentity = {
  installationId: 'consumer-install',
  projectId: 'customer-project',
  region: 'us-central1',
  databaseId: '(default)',
  release: {
    commitSha: '0123456789abcdef0123456789abcdef01234567',
    archiveDigest: `sha256:${'a'.repeat(64)}`,
  },
};
const specBytes = readFileSync('infra/gcp/firestore/firestore.indexes.json');
const spec = JSON.parse(specBytes.toString('utf8')) as {
  indexes: Array<{
    collectionGroup: string;
    queryScope: string;
    fields: Array<{ fieldPath: string; order?: string }>;
  }>;
  fieldOverrides: Array<{ collectionGroup: string; fieldPath: string }>;
};
const prefix = `projects/${identity.projectId}/databases/${identity.databaseId}/collectionGroups/`;

function liveIndexes(databaseId = identity.databaseId) {
  const databasePrefix = `projects/${identity.projectId}/databases/${databaseId}/collectionGroups/`;
  return spec.indexes.map((index, number) => ({
    name: `${databasePrefix}${index.collectionGroup}/indexes/${number + 1}`,
    queryScope: index.queryScope,
    fields: [
      ...index.fields,
      {
        fieldPath: '__name__',
        order: index.fields.at(-1)?.order === 'DESCENDING' ? 'DESCENDING' : 'ASCENDING',
      },
    ],
    state: 'READY',
  }));
}

function liveOverrides(databaseId = identity.databaseId) {
  const databasePrefix = `projects/${identity.projectId}/databases/${databaseId}/collectionGroups/`;
  return [
    {
      name: `${databasePrefix}__default__/fields/*`,
      indexConfig: { indexes: [] },
    },
    ...spec.fieldOverrides.map((field) => ({
      name: `${databasePrefix}${field.collectionGroup}/fields/${field.fieldPath}`,
      indexConfig: { indexes: [] },
    })),
  ];
}

function fakeLists(indexes: unknown, fields: unknown, calls: string[]): CommandRunner {
  return {
    async run(command, args) {
      calls.push([command, ...args].join(' '));
      if (args[2] === 'composite') return { ok: true, stdout: JSON.stringify(indexes), stderr: '' };
      if (args[2] === 'fields') return { ok: true, stdout: JSON.stringify(fields), stderr: '' };
      return { ok: false, stdout: '', stderr: 'unexpected command' };
    },
  };
}

describe('consumer Firestore index readiness', () => {
  it('provisions only missing manifest resources for the explicit named database', async () => {
    const commands: string[][] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        if (args[0] === 'firestore' && args[3] === 'list')
          return { ok: true, stdout: '[]', stderr: '' };
        commands.push([command, ...args]);
        return { ok: true, stdout: '', stderr: '' };
      },
    };
    const result = await provisionTargetFirestoreIndexes(
      runner,
      { ...identity, databaseId: 'assistant-production' },
      specBytes,
    );
    expect(result.indexesCreated).toBe(spec.indexes.length);
    expect(result.exemptionsCreated).toBe(spec.fieldOverrides.length);
    expect(commands).toHaveLength(spec.indexes.length + spec.fieldOverrides.length);
    expect(commands.every((args) => args.includes('--database=assistant-production'))).toBe(true);
    expect(commands.some((args) => args.includes('--disable-indexes'))).toBe(true);
    expect(
      commands.some((args) => args.some((arg) => arg.includes('vector-config={dimension='))),
    ).toBe(true);
  });

  it('is idempotent when every shared resource already exists', async () => {
    const calls: string[] = [];
    const runner = fakeLists(
      liveIndexes('assistant-production'),
      liveOverrides('assistant-production'),
      calls,
    );
    await expect(
      provisionTargetFirestoreIndexes(
        runner,
        { ...identity, databaseId: 'assistant-production' },
        specBytes,
      ),
    ).resolves.toEqual({ indexesCreated: 0, exemptionsCreated: 0 });
    expect(calls).toHaveLength(2);
  });

  it('declares the exact person experience scan index in the shared manifest', () => {
    expect(spec.indexes).toContainEqual({
      collectionGroup: 'memories',
      queryScope: 'COLLECTION',
      fields: [
        { fieldPath: 'agentId', order: 'ASCENDING' },
        { fieldPath: 'subjectContactId', order: 'ASCENDING' },
        { fieldPath: 'category', order: 'ASCENDING' },
      ],
    });
  });

  it('accepts exactly the trusted READY indexes and active field exemptions', async () => {
    const calls: string[] = [];
    await verifyConsumerIndexReadiness(
      fakeLists(liveIndexes(), liveOverrides(), calls),
      identity,
      specBytes,
    );
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.includes('--project=customer-project'))).toBe(true);
    expect(calls.every((call) => call.includes('--database=(default)'))).toBe(true);
    expect(calls.every((call) => call.includes('--format=json'))).toBe(true);
  });

  it.each([
    ['missing composite', () => liveIndexes().slice(1), liveOverrides],
    [
      'building composite',
      () => liveIndexes().map((row, i) => (i ? row : { ...row, state: 'CREATING' })),
      liveOverrides,
    ],
    [
      'extra composite',
      () => [...liveIndexes(), { ...liveIndexes()[0], name: `${prefix}extra/indexes/999` }],
      liveOverrides,
    ],
    [
      'foreign composite',
      () =>
        liveIndexes().map((row, i) =>
          i ? row : { ...row, name: row.name.replace('customer-project', 'foreign-project') },
        ),
      liveOverrides,
    ],
    [
      'changed composite fields',
      () => liveIndexes().map((row, i) => (i ? row : { ...row, fields: row.fields.slice(1) })),
      liveOverrides,
    ],
    ['missing exemption', liveIndexes, () => liveOverrides().slice(0, -1)],
    [
      'extra exemption',
      liveIndexes,
      () => [
        ...liveOverrides(),
        { name: `${prefix}extra/fields/mystery`, indexConfig: { indexes: [] } },
      ],
    ],
    [
      'foreign exemption',
      liveIndexes,
      () =>
        liveOverrides().map((row, i) =>
          i === 1 ? { ...row, name: row.name.replace('customer-project', 'foreign-project') } : row,
        ),
    ],
    [
      'reverting exemption',
      liveIndexes,
      () =>
        liveOverrides().map((row, i) =>
          i === 1 ? { ...row, indexConfig: { indexes: [], reverting: true } } : row,
        ),
    ],
    ['duplicate default field', liveIndexes, () => [liveOverrides()[0], ...liveOverrides()]],
  ])('rejects %s', async (_name, indexes, fields) => {
    await expect(
      verifyConsumerIndexReadiness(fakeLists(indexes(), fields(), []), identity, specBytes),
    ).rejects.toThrow();
  });

  it('fails closed on a malformed or failed authenticated list', async () => {
    const calls: string[] = [];
    const runner = fakeLists(liveIndexes(), liveOverrides(), calls);
    const original = runner.run.bind(runner);
    runner.run = async (command, args) =>
      args[2] === 'fields'
        ? { ok: false, stdout: '', stderr: 'permission denied' }
        : original(command, args);
    await expect(verifyConsumerIndexReadiness(runner, identity, specBytes)).rejects.toThrow(
      'permission denied',
    );
    await expect(
      verifyConsumerIndexReadiness(fakeLists({}, liveOverrides(), []), identity, specBytes),
    ).rejects.toThrow('malformed');
  });
});
