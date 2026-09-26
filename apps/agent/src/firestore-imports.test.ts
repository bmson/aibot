import { createHash, randomUUID } from 'node:crypto';
import type { ExecutorDeps } from '@assistant/core';
import { startPortableImport } from '@assistant/core/memory/import';
import { startPortableVoiceIngest } from '@assistant/core/memory/voice-ingest';
import type { Db } from '@assistant/db';
import {
  createFirestoreExecutionPersistence,
  embeddingSpaceKey,
  FirestoreImportCommandRepository,
  FirestoreImportJobRepository,
} from '@assistant/firestore';
import type { EmbeddingSpace, ImportJobRepository } from '@assistant/persistence';
import { Firestore } from '@google-cloud/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decodeRecord,
  encodeRecord,
  InstallationStore,
} from '../../../packages/firestore/src/store.js';
import type { AgentDeps } from './deps.js';
import { executeAgentTask } from './task-runner.js';

const emulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '');

const space: EmbeddingSpace = {
  provider: 'synthetic',
  model: 'import-fixture',
  dimensions: 1536,
  revision: '1',
};

function vectorFor(text: string): number[] {
  const slot = createHash('sha256').update(text).digest().readUInt16BE(0) % space.dimensions;
  return Array.from({ length: space.dimensions }, (_, index) => (index === slot ? 1 : 0.001));
}

function hashOf(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Paragraphs long enough to be one text unit, and so one window, each. */
function archive(letters: string[]): string {
  return letters
    .map((letter) => `WINDOW-${letter} ${'notes from the old days '.repeat(58)}`.trim())
    .join('\n\n');
}

type Fact = { content: string; subject: string; relationship?: string };

/** The facts each window yields; content carries the source so hashes never collide. */
function windowFacts(letter: string, source: string): { facts: Fact[]; occasions: unknown[] } {
  switch (letter) {
    case 'A':
      return {
        facts: [
          { content: `The owner grew up in Reykjavik (${source}).`, subject: 'owner' },
          {
            content: `Grace Hopper was the owner's manager at the lab (${source}).`,
            subject: 'Grace Hopper',
            relationship: 'former manager',
          },
        ],
        occasions: [
          {
            subject: 'Grace Hopper',
            kind: 'birthday',
            label: '',
            month: 12,
            day: 9,
            year: null,
            notes: '',
          },
        ],
      };
    case 'B':
      return {
        facts: [
          { content: `The owner prefers green tea in the morning (${source}).`, subject: 'owner' },
          { content: `The owner grew up in Reykjavik (${source}).`, subject: 'owner' },
        ],
        occasions: [],
      };
    case 'C':
      return {
        facts: [
          { content: `The owner learned to sail on Lake Union (${source}).`, subject: 'owner' },
        ],
        occasions: [],
      };
    default:
      return { facts: [], occasions: [] };
  }
}

describe.skipIf(!emulator)('Firestore import jobs with PostgreSQL offline', () => {
  const agentId = randomUUID();
  const ownerContactId = randomUUID();
  let offsetMs = 0;
  const store = new InstallationStore(
    new Firestore({ projectId: 'demo-assistant-test', databaseId: '(default)' }),
    `imports-${randomUUID()}`,
    () => new Date(Date.now() + offsetMs),
  );
  const persistence = createFirestoreExecutionPersistence(store, agentId, space);
  const importJobRepository = new FirestoreImportJobRepository(store, agentId, space);
  const commands = new FirestoreImportCommandRepository(store, agentId);
  const files = new Map<string, string>();
  const workspace = {
    async read(relPath: string) {
      const content = files.get(relPath);
      if (content === undefined)
        throw Object.assign(new Error(`ENOENT: no such file ${relPath}`), { code: 'ENOENT' });
      return content;
    },
    async write(relPath: string, content: string) {
      files.set(relPath, content);
      return { bytes: content.length };
    },
    async list() {
      return [];
    },
    async delete(relPath: string) {
      files.delete(relPath);
    },
  };
  const sqlAccess = vi.fn();
  const unavailable = new Proxy(
    {},
    {
      get: (_target, property) => {
        sqlAccess(property);
        throw new Error(`Unexpected SQL or model dependency access: ${String(property)}`);
      },
    },
  );
  const distill = vi.fn(async (_role: string, input: { system: string; prompt: string }) => {
    const letter = /WINDOW-([A-Z])/.exec(input.prompt)?.[1] ?? '';
    const source = /Source: ([^.]+)\./.exec(input.system)?.[1] ?? '';
    const { facts, occasions } = windowFacts(letter, source);
    return {
      ok: true,
      modelId: 'fixture',
      degraded: false,
      object: {
        facts: facts.map((fact) => ({
          ...fact,
          relationship: fact.relationship ?? '',
          kind: 'fact',
          category: 'knowledge',
          domain: 'personal',
          importance: 4,
          confidence: 0.9,
        })),
        occasions,
      },
    };
  });
  const router = {
    object: distill,
    embed: vi.fn(async (texts: string[]) => texts.map(vectorFor)),
  } as unknown as ExecutorDeps['router'];
  const deps = {
    config: { PERSISTENCE_DRIVER: 'firestore', FIRESTORE_AGENT_ID: agentId },
    db: unavailable as Db,
    router,
    dispatcher: unavailable as ExecutorDeps['dispatcher'],
    firestoreStore: store,
    persistence,
    importJobRepository: importJobRepository as ImportJobRepository,
    workspace,
    modules: {
      channels: [],
      emailObservers: [],
      jobUnavailable: () => null,
      channelUnavailable: () => null,
      taskKindUnavailable: () => null,
      taskHandlerFor: () => undefined,
    },
    registry: unavailable as AgentDeps['registry'],
    outOfBandNotifier: unavailable as AgentDeps['outOfBandNotifier'],
  } as unknown as AgentDeps;

  async function upload(source: string, letters: string[], windowsPerRun: number) {
    const workspacePath = `import/uploads/${randomUUID()}-${source}.txt`;
    await workspace.write(workspacePath, archive(letters));
    const started = await startPortableImport(commands, {
      source,
      workspacePath,
      kind: 'text',
      windowChars: 500,
      windowsPerRun,
    });
    return { ...started, workspacePath };
  }

  async function sourceMemories(source: string) {
    const snapshot = await store
      .collection('memories')
      .where('agentId', '==', agentId)
      .where('source', '==', source)
      .get();
    return snapshot.docs.map((doc) => ({
      raw: doc,
      row: decodeRecord<Record<string, unknown>>(doc.data()),
    }));
  }

  async function sourceRow(source: string) {
    const snapshot = await store
      .collection('importSources')
      .where('agentId', '==', agentId)
      .where('source', '==', source)
      .get();
    return snapshot.docs[0] ? decodeRecord<Record<string, unknown>>(snapshot.docs[0].data()) : null;
  }

  async function taskRow(taskId: string) {
    return decodeRecord<Record<string, unknown>>((await store.doc('tasks', taskId).get()).data());
  }

  beforeAll(async () => {
    await store.doc('agents', agentId).set({ id: agentId, name: 'Assistant', timezone: 'UTC' });
    await store.doc('contacts', ownerContactId).set(
      encodeRecord({
        id: ownerContactId,
        name: 'Ada Owner',
        aliases: [],
        emails: ['ada@example.test'],
        phones: [],
        relationship: 'self',
        notes: '',
        trust: 'owner',
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );
  });

  beforeEach(() => {
    distill.mockClear();
    sqlAccess.mockClear();
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
  });

  it('uploads, runs, reviews, and purges an import with provenance and graph cleanup', async () => {
    const started = await upload('Old Notes', ['A', 'B', 'C', 'D'], 2);
    expect(await sourceRow('old-notes')).toMatchObject({
      status: 'pending',
      taskId: started.taskId,
      workspacePath: started.workspacePath,
      kind: 'text',
    });
    await expect(upload('old-notes', ['A'], 2)).rejects.toThrow(
      'import "old-notes" is already pending',
    );

    expect(await executeAgentTask(deps, started.taskId)).toMatchObject({ outcome: 'sleeping' });
    expect(await sourceRow('old-notes')).toMatchObject({ status: 'running', itemsProcessed: 2 });
    offsetMs += 60_000;
    expect(await executeAgentTask(deps, started.taskId)).toMatchObject({ outcome: 'done' });
    expect(distill).toHaveBeenCalledTimes(4);

    const snapshotBase = `.assistant/imports/old-notes/${started.taskId}`;
    expect([...files.keys()].filter((path) => path.startsWith(snapshotBase)).sort()).toEqual([
      `${snapshotBase}/manifest.json`,
      `${snapshotBase}/windows-000000.json`,
    ]);

    const memories = await sourceMemories('old-notes');
    expect(memories).toHaveLength(4);
    for (const { raw, row } of memories) {
      expect(row).toMatchObject({
        agentId,
        category: 'knowledge',
        originTrust: 'owner',
        source: 'old-notes',
        sourceTaskId: started.taskId,
        importance: 3,
        confidence: '0.60',
        ownerConfirmed: false,
        supersededById: null,
      });
      expect(raw.get('embeddingSpace')).toBe(embeddingSpaceKey(space));
      expect(typeof raw.get('retrievalRevision')).toBe('string');
      expect(
        (await store.doc('memoryContentHashes', String(row.contentHash)).get()).get('memoryId'),
      ).toBe(row.id);
    }
    const grace = memories.find(({ row }) => String(row.content).startsWith('Grace Hopper'));
    const graceContactId = grace?.row.subjectContactId as string;
    expect(grace?.row.quarantined).toBe(true);
    expect((await store.doc('contacts', graceContactId).get()).get('relationship')).toBe(
      'former manager',
    );
    expect(
      memories.filter(({ row }) => row.subjectContactId === ownerContactId && !row.quarantined),
    ).toHaveLength(3);
    const occasions = await store
      .collection('occasions')
      .where('contactId', '==', graceContactId)
      .get();
    expect(occasions.docs.map((doc) => doc.data())).toEqual([
      expect.objectContaining({
        kind: 'birthday',
        month: 12,
        day: 9,
        quarantined: true,
        originTrust: 'owner',
        source: 'old-notes',
      }),
    ]);
    expect(await sourceRow('old-notes')).toMatchObject({
      status: 'done',
      itemsTotal: 4,
      itemsProcessed: 4,
      memoriesSaved: 4,
      memoriesQuarantined: 1,
      error: null,
    });
    const task = await taskRow(started.taskId);
    expect(task.status).toBe('done');
    expect(task.progress).toContain(
      '4 memories (1 quarantined for review), 1 occasion(s), 1 duplicates',
    );
    expect((await store.doc('ownerCards', agentId).get()).get('compiledAt')).toBeTruthy();

    // Recall reads the imported vectors in the configured embedding space.
    const tea = 'The owner prefers green tea in the morning (old-notes).';
    const recalled = await persistence.memory.recall({
      agentId,
      query: 'green tea',
      embedding: vectorFor(tea),
      limit: 3,
    });
    expect(recalled.memories.map((memory) => memory.content)).toContain(tea);

    // Approve the held fact, then give it a graph fact the purge must remove.
    expect(await commands.review('old-notes', 'approve')).toEqual({ agentId, reviewed: 1 });
    expect((await grace?.raw.ref.get())?.get('quarantined')).toBe(false);
    expect(await sourceRow('old-notes')).toMatchObject({ memoriesQuarantined: 0 });
    const graceId = String(grace?.row.id);
    const [personEntity, labEntity, relationId, keptId] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    await Promise.all([
      store.doc('knowledgeGraphEntities', personEntity).set({ id: personEntity, agentId }),
      store.doc('knowledgeGraphEntities', labEntity).set({ id: labEntity, agentId }),
      store.doc('knowledgeGraphRelations', relationId).set({
        id: relationId,
        agentId,
        subjectEntityId: personEntity,
        objectEntityId: labEntity,
        sourceMemoryId: graceId,
      }),
      store.doc('knowledgeGraphSources', graceId).set({ memoryId: graceId, agentId }),
      store
        .doc('memories', keptId)
        .set({ id: keptId, agentId, source: 'other', quarantined: false }),
    ]);

    expect(await commands.purge('old-notes')).toEqual({ agentId, purged: 4 });
    expect(await sourceMemories('old-notes')).toEqual([]);
    for (const { row } of memories) {
      const hash = String(row.contentHash);
      expect((await store.doc('memoryContentHashes', hash).get()).exists).toBe(false);
      // Purging never tombstones: re-running the import may learn them again.
      expect((await store.doc('memoryTombstones', hash).get()).exists).toBe(false);
      expect(
        (await store.doc('graphDeletionIntents', String(row.id)).get()).get('cleanupCompletedAt'),
      ).toBeTruthy();
    }
    expect((await store.doc('knowledgeGraphRelations', relationId).get()).exists).toBe(false);
    expect((await store.doc('knowledgeGraphEntities', personEntity).get()).exists).toBe(false);
    expect((await store.doc('knowledgeGraphSources', graceId).get()).exists).toBe(false);
    expect((await store.doc('memories', keptId).get()).exists).toBe(true);
    expect((await store.doc('ownerCards', agentId).get()).get('invalidatedAt')).toBeTruthy();
    expect(await sourceRow('old-notes')).toMatchObject({ status: 'purged', memoriesSaved: 0 });

    const removed = await commands.remove('old-notes');
    expect(removed).toEqual({ agentId, purgedMemories: 0, workspacePath: started.workspacePath });
    expect(await sourceRow('old-notes')).toBeNull();
    expect(sqlAccess).not.toHaveBeenCalled();
  });

  it('resumes after a partial run without saving a committed window twice', async () => {
    const started = await upload('retry-notes', ['A', 'B', 'C', 'D'], 6);
    let failed = false;
    const original = distill.getMockImplementation();
    distill.mockImplementation(async (role, input) => {
      if (!failed && input.prompt.includes('WINDOW-C')) {
        failed = true;
        throw new Error('provider outage');
      }
      return (original as NonNullable<typeof original>)(role, input);
    });
    try {
      expect(await executeAgentTask(deps, started.taskId)).toMatchObject({ outcome: 'failed' });
      expect(await sourceMemories('retry-notes')).toHaveLength(3);
      expect((await taskRow(started.taskId)).state).toMatchObject({
        plannerState: { import: { windowIndex: 2, saved: 3, duplicates: 1, quarantined: 1 } },
      });

      offsetMs += 10 * 60_000;
      expect(await executeAgentTask(deps, started.taskId)).toMatchObject({ outcome: 'done' });
    } finally {
      distill.mockImplementation(original as NonNullable<typeof original>);
    }
    const prompts = distill.mock.calls.map(([, input]) => /WINDOW-([A-Z])/.exec(input.prompt)?.[1]);
    expect(prompts.sort()).toEqual(['A', 'B', 'C', 'C', 'D']);
    const memories = await sourceMemories('retry-notes');
    expect(memories).toHaveLength(4);
    expect(new Set(memories.map(({ row }) => row.contentHash)).size).toBe(4);
    expect(await sourceRow('retry-notes')).toMatchObject({
      status: 'done',
      itemsProcessed: 4,
      memoriesSaved: 4,
      memoriesQuarantined: 1,
    });

    // Rejecting the held fact deletes and tombstones it.
    const held = memories.find(({ row }) => row.quarantined);
    expect(await commands.review('retry-notes', 'reject')).toEqual({ agentId, reviewed: 1 });
    expect((await store.doc('memories', String(held?.row.id)).get()).exists).toBe(false);
    expect(
      (await store.doc('memoryTombstones', String(held?.row.contentHash)).get()).get('reason'),
    ).toBe('quarantine_reject');
    expect(await sourceMemories('retry-notes')).toHaveLength(3);
    expect(sqlAccess).not.toHaveBeenCalled();
  });

  it('fences a reclaimed lease so the stale worker cannot commit', async () => {
    const started = await upload('reclaim-notes', ['A', 'B', 'C', 'D'], 6);
    let entered!: () => void;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    const original = distill.getMockImplementation() as NonNullable<
      ReturnType<typeof distill.getMockImplementation>
    >;
    distill.mockImplementation(async (role, input) => {
      if (!held && input.prompt.includes('WINDOW-B')) {
        held = true;
        entered();
        await gate;
      }
      return original(role, input);
    });
    try {
      const stale = executeAgentTask(deps, started.taskId).catch((error: unknown) => error);
      await blocked;
      const staleTask = await taskRow(started.taskId);
      expect(staleTask.state).toMatchObject({ plannerState: { import: { windowIndex: 1 } } });

      // The stale worker's lease expires while its model call hangs.
      offsetMs += 11 * 60_000;
      expect(await executeAgentTask(deps, started.taskId)).toMatchObject({ outcome: 'done' });

      const staleCommit = await importJobRepository.commitImportWindow(
        {
          agentId,
          source: 'reclaim-notes',
          taskId: started.taskId,
          queueGeneration: Number(staleTask.queueGeneration),
          leaseToken: String(staleTask.leaseToken),
        },
        {
          windowIndex: 1,
          facts: [
            {
              content: 'A stale worker fact.',
              contentHash: hashOf('A stale worker fact.'),
              embedding: vectorFor('A stale worker fact.'),
              kind: 'fact',
              domain: null,
              importance: 3,
              confidence: '0.60',
              quarantined: false,
              subjectContactId: null,
              validFrom: null,
            },
          ],
          occasions: [],
          describe: () => ({ progress: 'stale', progressPercent: 0 }),
        },
      );
      expect(staleCommit).toBeNull();

      release();
      await stale;
    } finally {
      distill.mockImplementation(original);
    }
    const memories = await sourceMemories('reclaim-notes');
    expect(memories).toHaveLength(4);
    expect(new Set(memories.map(({ row }) => row.contentHash)).size).toBe(4);
    expect(
      (await store.doc('memoryContentHashes', hashOf('A stale worker fact.')).get()).exists,
    ).toBe(false);
    expect((await taskRow(started.taskId)).status).toBe('done');
    expect(await sourceRow('reclaim-notes')).toMatchObject({
      status: 'done',
      itemsProcessed: 4,
      memoriesSaved: 4,
    });
    expect(sqlAccess).not.toHaveBeenCalled();
  });

  it('ingests uploaded voice samples once per owner text', async () => {
    const texts = [
      'Thanks for the update, I will review the draft tonight and send notes.',
      'Happy to help with the move on Saturday, just tell me when to show up.',
      'Could we push our call to Thursday? Something came up this afternoon.',
    ];
    const workspacePath = `import/uploads/${randomUUID()}-sent.json`;
    await workspace.write(
      workspacePath,
      JSON.stringify([
        ...texts.map((text) => ({ from: 'Ada Owner <ada@example.test>', text })),
        { from: 'Someone Else <else@example.test>', text: 'A received message that is not mine.' },
      ]),
    );
    const first = await startPortableVoiceIngest(commands, {
      source: 'sent mail',
      workspacePath,
      kind: 'json',
      register: 'email_casual',
    });
    expect(await executeAgentTask(deps, first.taskId)).toMatchObject({
      outcome: 'done',
      detail: expect.stringContaining('3 samples (0 duplicates)'),
    });
    const samples = await store.collection('writingSamples').where('agentId', '==', agentId).get();
    expect(samples.docs.map((doc) => doc.get('text')).sort()).toEqual([...texts].sort());
    for (const doc of samples.docs) {
      expect(doc.data()).toMatchObject({
        register: 'email_casual',
        context: 'upload:voice-samples-sent-mail',
        embeddingSpace: embeddingSpaceKey(space),
      });
    }
    expect(await sourceRow('voice-samples-sent-mail')).toMatchObject({
      status: 'done',
      itemsTotal: 3,
      itemsProcessed: 3,
      memoriesSaved: 3,
    });

    const second = await startPortableVoiceIngest(commands, {
      source: 'sent again',
      workspacePath,
      kind: 'json',
      register: 'email_casual',
    });
    expect(await executeAgentTask(deps, second.taskId)).toMatchObject({
      outcome: 'done',
      detail: expect.stringContaining('0 samples (3 duplicates)'),
    });
    expect(
      (await store.collection('writingSamples').where('agentId', '==', agentId).get()).size,
    ).toBe(3);
    expect(sqlAccess).not.toHaveBeenCalled();
  });
});
