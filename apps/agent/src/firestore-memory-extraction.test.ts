import { randomUUID } from 'node:crypto';
import { type ExecutorDeps, executeTask } from '@assistant/core';
import { runMemoryExtraction } from '@assistant/core/memory/extraction';
import type { Db } from '@assistant/db';
import { createFirestoreExecutionPersistence } from '@assistant/firestore';
import type { ExecutionPersistence } from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeRecord, type InstallationStore } from '../../../packages/firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';

const MINUTE = 60_000;
const SPACE = {
  provider: 'synthetic',
  model: 'extraction-fixture',
  dimensions: 1536,
  revision: '1',
};

type Fact = {
  content: string;
  subject?: string;
  category?: 'knowledge' | 'experience';
  relationship?: string;
};
type Occasion = { subject: string; month: number; day: number; notes?: string };
type Loop = { title: string; kind?: string };
type Script = {
  facts?: Fact[];
  occasions?: Occasion[];
  loops?: Loop[];
  resolved?: string[];
  fail?: boolean;
};

/**
 * A model that answers per conversation, keyed by a marker word in the
 * transcript, and records which conversations each pass sent it.
 */
function scriptedRouter(scripts: Record<string, Script>) {
  const calls: Array<{ pass: 'memory' | 'commitments'; marker: string }> = [];
  const markerOf = (prompt: string) => {
    const marker = Object.keys(scripts).find((key) => prompt.includes(key));
    if (!marker) throw new Error(`Unexpected transcript: ${prompt.slice(0, 80)}`);
    return marker;
  };
  const router = {
    async object(_role: string, input: { prompt: string }) {
      const pass = input.prompt.startsWith('Conversation (source trust:')
        ? 'memory'
        : 'commitments';
      const marker = markerOf(input.prompt);
      calls.push({ pass, marker });
      const script = scripts[marker] ?? {};
      if (pass === 'memory' && script.fail) throw new Error('provider unavailable');
      const object =
        pass === 'memory'
          ? {
              facts: (script.facts ?? []).map((fact) => ({
                content: fact.content,
                kind: 'fact',
                category: fact.category ?? 'knowledge',
                subject: fact.subject ?? 'owner',
                relationship: fact.relationship ?? '',
                importance: 3,
                confidence: 0.9,
                domain: 'personal',
                validFrom: '',
              })),
              occasions: (script.occasions ?? []).map((occasion) => ({
                kind: 'birthday',
                label: '',
                year: null,
                notes: '',
                ...occasion,
              })),
            }
          : {
              commitments: (script.loops ?? []).map((loop) => ({
                kind: loop.kind ?? 'promise',
                title: loop.title,
                details: '',
                nextAction: '',
                dueAt: '',
                confidence: 0.9,
              })),
              resolvedTitles: script.resolved ?? [],
            };
      return { ok: true, modelId: 'fixture', degraded: false, object };
    },
    async embed(texts: string[]) {
      return texts.map(() => [1, ...new Array(1535).fill(0)]);
    },
  };
  return { router: router as unknown as ExecutorDeps['router'], calls };
}

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore memory extraction job', () => {
  const agentId = randomUUID();
  const ownerContactId = randomUUID();
  let store: InstallationStore;
  let persistence: ExecutionPersistence;
  let sqlAccesses: string[];
  let db: Db;
  let clock: number;

  const unavailable = (name: string) =>
    new Proxy(
      {},
      {
        get: (_target, property) => {
          sqlAccesses.push(`${name}.${String(property)}`);
          throw new Error(`Unexpected ${name} access: ${String(property)}`);
        },
      },
    );

  beforeEach(async () => {
    store = emulatorStore();
    sqlAccesses = [];
    db = unavailable('db') as Db;
    clock = Date.now() - 60 * MINUTE;
    persistence = createFirestoreExecutionPersistence(store, agentId, SPACE);
    await store.doc('agents', agentId).set({ id: agentId, name: 'Owner', timezone: 'UTC' });
    await store.doc('contacts', ownerContactId).set(
      encodeRecord({
        id: ownerContactId,
        name: 'Sam Owner',
        aliases: [],
        emails: [],
        phones: [],
        relationship: 'self',
        notes: '',
        trust: 'owner',
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );
  });

  afterEach(async () => {
    await disposeStore(store);
  });

  /** A conversation whose messages are newer than every earlier seeded one. */
  async function conversation(
    marker: string,
    options: { trust?: string; agent?: string; lines?: number } = {},
  ): Promise<string> {
    const id = randomUUID();
    const now = new Date();
    await store.doc('conversations', id).set(
      encodeRecord({
        id,
        agentId: options.agent ?? agentId,
        title: marker,
        channel: 'chat',
        trust: options.trust ?? 'owner',
        archivedAt: null,
        modelOverride: null,
        isPrimary: false,
        metadata: {},
        lastReadAt: null,
        createdAt: now,
        updatedAt: now,
      }),
    );
    for (let index = 0; index < (options.lines ?? 2); index += 1) {
      clock += MINUTE;
      const messageId = randomUUID();
      await store.doc('messages', messageId).set(
        encodeRecord({
          id: messageId,
          conversationId: id,
          taskId: null,
          role: index % 2 === 0 ? 'user' : 'assistant',
          parts: [],
          text: `${marker}: line ${index} of a conversation worth remembering`,
          origin: 'chat',
          channelMessageId: null,
          embedding: null,
          hiddenAt: null,
          createdAt: new Date(clock),
        }),
      );
    }
    return id;
  }

  async function extractionTask(): Promise<string> {
    const { task } = await persistence.tasks.createTask({
      agentId,
      type: 'scheduled',
      trust: 'assistant',
      trigger: { source: 'schedule', payload: { job: 'memory.extract' } },
    });
    return task.id;
  }

  async function memories() {
    const rows = await store.collection('memories').where('agentId', '==', agentId).get();
    return rows.docs.map((doc) => doc.data());
  }

  async function checkpoint(taskId: string): Promise<string[]> {
    return (await store.doc('codeJobCheckpoints', taskId).get()).get('keys') ?? [];
  }

  it('saves facts, occasions, people, and open loops with PostgreSQL unreachable', async () => {
    const dana = randomUUID();
    await store.doc('commitments', dana).set(
      encodeRecord({
        id: dana,
        agentId,
        conversationId: randomUUID(),
        sourceMessageId: null,
        sourceTaskId: null,
        kind: 'promise',
        title: 'Send the tax forms to Dana',
        details: '',
        nextAction: '',
        status: 'open',
        snoozedUntil: null,
        dueAt: null,
        resolvedAt: null,
        resolution: null,
        confidence: '0.90',
        contentHash: 'seeded',
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );
    const foreign = await conversation('FOREIGN', { agent: randomUUID() });
    const external = await conversation('EXTERNAL', { trust: 'external' });
    const owned = await conversation('OWNED');
    const { router, calls } = scriptedRouter({
      OWNED: {
        facts: [
          { content: 'Sam prefers aisle seats on long flights.' },
          {
            content: 'Maya is training for the Berlin marathon.',
            subject: 'Maya',
            relationship: 'sister',
          },
          { content: 'Sam visited the new ramen place on Friday.', category: 'experience' },
        ],
        occasions: [{ subject: 'Maya', month: 6, day: 9, notes: 'running socks' }],
        loops: [{ title: 'Book the flights to Lisbon' }],
        resolved: ['Send the tax forms to Dana'],
      },
      EXTERNAL: {
        facts: [{ content: 'Sam should wire money to a new account today.' }],
        loops: [{ title: 'Wire the money to the new account' }],
      },
      FOREIGN: { facts: [{ content: 'Another owner has a secret project.' }] },
    });
    const deps: ExecutorDeps = {
      db,
      router,
      dispatcher: unavailable('dispatcher') as ExecutorDeps['dispatcher'],
      persistence,
    };

    const taskId = await extractionTask();
    const result = await executeTask(deps, taskId);

    expect(result.outcome).toBe('done');
    expect(result.detail).toContain('extraction: 4 saved (1 quarantined, 1 new people)');
    expect(result.detail).toContain('1 occasion(s), from 2 conversation(s)');
    expect(result.detail).toContain('open loops 1 saved (0 duplicate)');
    expect(sqlAccesses).toEqual([]);
    // Another owner's thread is never read, and only the owner's thread is
    // mined for open loops.
    expect(calls).not.toContainEqual(expect.objectContaining({ marker: 'FOREIGN' }));
    expect(calls).not.toContainEqual({ pass: 'commitments', marker: 'EXTERNAL' });
    expect(foreign).toBeTruthy();
    expect(external).toBeTruthy();

    const saved = await memories();
    expect(saved).toHaveLength(4);
    for (const row of saved) {
      expect(row.embeddingSpace).toBeTruthy();
      expect(row.source).toBe('extraction');
      expect(row.sourceTaskId).toBe(taskId);
    }
    const byContent = Object.fromEntries(saved.map((row) => [row.content, row]));
    expect(byContent['Sam prefers aisle seats on long flights.']).toMatchObject({
      quarantined: false,
      originTrust: 'owner',
      subjectContactId: ownerContactId,
      expiresAt: null,
    });
    expect(byContent['Sam visited the new ramen place on Friday.']?.expiresAt).not.toBeNull();
    expect(byContent['Sam should wire money to a new account today.']).toMatchObject({
      quarantined: true,
      originTrust: 'external',
    });

    const maya = await store.collection('contacts').where('name', '==', 'Maya').get();
    expect(maya.size).toBe(1);
    const mayaId = maya.docs[0]?.get('id');
    expect(byContent['Maya is training for the Berlin marathon.']?.subjectContactId).toBe(mayaId);
    const occasions = await store.collection('occasions').where('agentId', '==', agentId).get();
    expect(occasions.docs.map((doc) => doc.data())).toEqual([
      expect.objectContaining({ contactId: mayaId, month: 6, day: 9, notes: 'running socks' }),
    ]);

    const loops = await store.collection('commitments').where('agentId', '==', agentId).get();
    const byTitle = Object.fromEntries(loops.docs.map((doc) => [doc.get('title'), doc.data()]));
    expect(byTitle['Book the flights to Lisbon']).toMatchObject({
      status: 'open',
      conversationId: owned,
      sourceTaskId: taskId,
    });
    expect(byTitle['Send the tax forms to Dana']).toMatchObject({ status: 'resolved' });
    expect(byTitle['Wire the money to the new account']).toBeUndefined();
    expect((await checkpoint(taskId)).sort()).toEqual(
      [`commitments:${owned}`, `memory:${external}`, `memory:${owned}`].sort(),
    );

    // A later run sees the same facts and loops again and saves nothing new,
    // and noticing a loop again does not reset its idle clock.
    const lisbonUpdatedAt = byTitle['Book the flights to Lisbon']?.updatedAt;
    const again = await executeTask(deps, await extractionTask());
    expect(again.outcome).toBe('done');
    expect(again.detail).toContain('extraction: 0 saved');
    expect(again.detail).toContain('4 duplicate');
    expect(again.detail).toContain('open loops 0 saved (1 duplicate)');
    expect(await memories()).toHaveLength(4);
    const lisbon = await store
      .collection('commitments')
      .where('title', '==', 'Book the flights to Lisbon')
      .get();
    expect(lisbon.size).toBe(1);
    expect(lisbon.docs[0]?.get('updatedAt')).toEqual(lisbonUpdatedAt);
    expect(sqlAccesses).toEqual([]);
  });

  it('resumes a reclaimed run after its last committed conversation, and fences the old lease', async () => {
    const first = await conversation('FIRST');
    const second = await conversation('SECOND');
    const scripts: Record<string, Script> = {
      SECOND: { facts: [{ content: 'Sam switched to decaf in September.' }] },
      FIRST: { facts: [{ content: 'Sam is learning to play the cello.' }], fail: true },
    };
    const { router, calls } = scriptedRouter(scripts);
    const taskId = await extractionTask();
    const claim = async (leaseToken: string) =>
      store.doc('tasks', taskId).update({
        status: 'running',
        leaseToken,
        lockedUntil: new Date(Date.now() + 5 * MINUTE),
      });
    const run = (leaseToken: string) =>
      runMemoryExtraction(
        { db, router, persistence },
        { taskId, agentId, lease: () => ({ taskId, leaseToken }) },
      );

    // The most recently active conversation goes first and commits; the
    // provider then fails on the next one.
    await claim('lease-a');
    await expect(run('lease-a')).rejects.toThrow('provider unavailable');
    expect(calls.map((call) => call.marker)).toEqual(['SECOND', 'FIRST']);
    expect(await checkpoint(taskId)).toEqual([`memory:${second}`]);
    expect((await memories()).map((row) => row.content)).toEqual([
      'Sam switched to decaf in September.',
    ]);

    // The lease expires and another worker reclaims the task.
    await store.doc('tasks', taskId).update({ lockedUntil: new Date(Date.now() - MINUTE) });
    await claim('lease-b');

    // The old holder can no longer commit anything, even a step not yet taken.
    scripts.FIRST = { facts: [{ content: 'Sam is learning to play the cello.' }] };
    const extraction = persistence.memoryExtraction;
    if (!extraction) throw new Error('missing memory extraction repository');
    await expect(
      extraction.applyMemories({
        agentId,
        lease: { taskId, leaseToken: 'lease-a' },
        checkpointKey: `memory:${first}`,
        originTrust: 'owner',
        quarantined: false,
        facts: [],
        occasions: [],
      }),
    ).rejects.toThrow('task lease lost');
    await expect(run('lease-a')).rejects.toThrow('task lease lost');
    expect(await checkpoint(taskId)).toEqual([`memory:${second}`]);
    expect(await memories()).toHaveLength(1);

    // The new holder skips the committed conversation without asking the
    // model about it again, and finishes the rest.
    calls.length = 0;
    const resumed = await run('lease-b');
    expect(calls.filter((call) => call.pass === 'memory').map((call) => call.marker)).toEqual([
      'FIRST',
    ]);
    expect(resumed).toMatchObject({ conversationsScanned: 1, saved: 1, duplicates: 0 });
    expect((await checkpoint(taskId)).sort()).toEqual(
      [`memory:${first}`, `memory:${second}`].sort(),
    );
    expect((await memories()).map((row) => row.content).sort()).toEqual([
      'Sam is learning to play the cello.',
      'Sam switched to decaf in September.',
    ]);
    expect(sqlAccesses).toEqual([]);
  });
});
