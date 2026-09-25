import { randomUUID } from 'node:crypto';
import { type ExecutorDeps, executeTask } from '@assistant/core';
import type { Db } from '@assistant/db';
import { createFirestoreExecutionPersistence } from '@assistant/firestore';
import type { ExecutionPersistence } from '@assistant/persistence';
import { FieldValue } from '@google-cloud/firestore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { embeddingSpaceKey } from '../../../packages/firestore/src/memory.js';
import { encodeRecord, type InstallationStore } from '../../../packages/firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';

const MINUTE = 60_000;
const SPACE = { provider: 'synthetic', model: 'segment-fixture', dimensions: 1536, revision: '1' };
const OTHER_SPACE = { ...SPACE, revision: '2' };

/** A unit vector on one axis: distinct axes are orthogonal, so they read as different topics. */
function axis(index: number): number[] {
  const vector = new Array(1536).fill(0);
  vector[index] = 1;
  return vector;
}

/**
 * Summaries name the topic marker found in the slice, and each summary embeds
 * on its topic's axis (offset so it never collides with a message axis).
 */
function topicRouter() {
  const summaries: string[] = [];
  const router = {
    async generate(_role: string, input: { prompt: string }) {
      const topic = ['sailing', 'mortgage', 'garden'].find((word) => input.prompt.includes(word));
      const text = `Talked about ${topic ?? 'something'}`;
      summaries.push(text);
      return { ok: true, text, modelId: 'fixture', degraded: false };
    },
    async embed(texts: string[]) {
      return texts.map((text) =>
        axis(text.includes('sailing') ? 100 : text.includes('mortgage') ? 101 : 102),
      );
    },
  };
  return { router: router as unknown as ExecutorDeps['router'], summaries };
}

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore chat segmentation job', () => {
  const agentId = randomUUID();
  let store: InstallationStore;
  let persistence: ExecutionPersistence;
  let deps: ExecutorDeps;
  let summaries: string[];
  const now = Date.now();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * MINUTE);

  beforeEach(async () => {
    store = emulatorStore();
    const unavailable = (name: string) =>
      new Proxy(
        {},
        {
          get: (_target, property) => {
            throw new Error(`Unexpected ${name} access: ${String(property)}`);
          },
        },
      );
    persistence = createFirestoreExecutionPersistence(store, agentId, SPACE);
    const fixture = topicRouter();
    summaries = fixture.summaries;
    deps = {
      db: unavailable('db') as Db,
      router: fixture.router,
      dispatcher: unavailable('dispatcher') as ExecutorDeps['dispatcher'],
      persistence,
    };
    await store.doc('agents', agentId).set({ id: agentId, name: 'Owner', timezone: 'UTC' });
  });

  afterEach(async () => {
    await disposeStore(store);
  });

  async function conversation(input: { trust?: string; agent?: string; minutesAgo?: number }) {
    const id = randomUUID();
    await store.doc('conversations', id).set(
      encodeRecord({
        id,
        agentId: input.agent ?? agentId,
        trust: input.trust ?? 'owner',
        channel: 'web',
        title: 'Thread',
        createdAt: at(600),
        updatedAt: at(input.minutesAgo ?? 0),
      }),
    );
    return id;
  }

  async function message(
    conversationId: string,
    input: {
      text: string;
      topic: number;
      minutesAgo: number;
      role?: string;
      space?: typeof SPACE | null;
    },
  ) {
    const id = randomUUID();
    const space = input.space === undefined ? SPACE : input.space;
    await store.doc('messages', id).set({
      ...encodeRecord({
        id,
        conversationId,
        taskId: null,
        role: input.role ?? 'user',
        parts: [{ type: 'text', text: input.text }],
        text: input.text,
        origin: 'owner',
        channelMessageId: null,
        hiddenAt: null,
        createdAt: at(input.minutesAgo),
      }),
      ...(space
        ? {
            embedding: FieldValue.vector(axis(input.topic)),
            embeddingSpace: embeddingSpaceKey(space),
          }
        : { embedding: null }),
    });
    return id;
  }

  async function runJob(): Promise<string | undefined> {
    const { task } = await persistence.tasks.createTask({
      agentId,
      type: 'scheduled',
      trust: 'assistant',
      trigger: { source: 'schedule', payload: { job: 'chat.segment' } },
    });
    const result = await executeTask(deps, task.id);
    expect(result.outcome).toBe('done');
    return result.detail;
  }

  async function segments(conversationId: string) {
    const rows = await store
      .collection('conversationSegments')
      .where('conversationId', '==', conversationId)
      .get();
    return rows.docs
      .map((doc) => doc.data())
      .sort((a, b) => a.startedAt.toMillis() - b.startedAt.toMillis());
  }

  it('splits a settled thread on topic drift and history recall finds the segments', async () => {
    const thread = await conversation({ minutesAgo: 100 });
    const sailing = await message(thread, {
      text: 'Thinking about sailing lessons',
      topic: 1,
      minutesAgo: 130,
    });
    await message(thread, {
      text: 'Which sailing club?',
      topic: 1,
      minutesAgo: 129,
      role: 'assistant',
    });
    const sailingEnd = await message(thread, {
      text: 'The sailing club by the harbour',
      topic: 1,
      minutesAgo: 128,
    });
    const mortgage = await message(thread, {
      text: 'Also the mortgage renewal',
      topic: 2,
      minutesAgo: 110,
    });
    const mortgageEnd = await message(thread, {
      text: 'Renew the mortgage for five years',
      topic: 2,
      minutesAgo: 109,
      role: 'assistant',
    });

    expect(await runJob()).toBe('segmentation: 2 new segment(s) across 1 conversation(s)');
    const rows = await segments(thread);
    expect(
      rows.map((row) => [row.startMessageId, row.endMessageId, row.messageCount, row.summary]),
    ).toEqual([
      [sailing, sailingEnd, 3, 'Talked about sailing'],
      [mortgage, mortgageEnd, 2, 'Talked about mortgage'],
    ]);
    for (const row of rows) {
      expect(row.agentId).toBe(agentId);
      expect(row.embeddingSpace).toBe(embeddingSpaceKey(SPACE));
      expect(row.embedding.toArray()).toHaveLength(1536);
    }

    const recalled = await persistence.history.segments({
      agentId,
      embedding: axis(101),
      limit: 2,
      exclude: { conversationId: randomUUID(), sinceCreatedAt: new Date() },
    });
    expect(recalled[0]).toMatchObject({
      conversationId: thread,
      summary: 'Talked about mortgage',
      startMessageId: mortgage,
    });
  });

  it('resumes after the latest segment and holds back a topic still in progress', async () => {
    const thread = await conversation({});
    await message(thread, { text: 'sailing one', topic: 1, minutesAgo: 200 });
    await message(thread, { text: 'sailing two', topic: 1, minutesAgo: 199 });
    await runJob();
    expect(await segments(thread)).toHaveLength(1);

    // A second run over the same messages records nothing new.
    await runJob();
    expect(await segments(thread)).toHaveLength(1);

    // New turns: a settled garden topic, then a mortgage topic from a minute ago.
    await message(thread, { text: 'garden one', topic: 3, minutesAgo: 90 });
    await message(thread, { text: 'garden two', topic: 3, minutesAgo: 89 });
    await message(thread, { text: 'mortgage one', topic: 2, minutesAgo: 2 });
    await message(thread, { text: 'mortgage two', topic: 2, minutesAgo: 1 });
    await runJob();
    expect((await segments(thread)).map((row) => row.summary)).toEqual([
      'Talked about sailing',
      'Talked about garden',
    ]);
  });

  it('skips vectors from another space, unembedded turns, and threads it does not own', async () => {
    const thread = await conversation({});
    await message(thread, {
      text: 'sailing stale space',
      topic: 1,
      minutesAgo: 120,
      space: OTHER_SPACE,
    });
    await message(thread, { text: 'sailing no vector', topic: 1, minutesAgo: 119, space: null });
    const first = await message(thread, { text: 'sailing kept', topic: 1, minutesAgo: 118 });
    await message(thread, { text: 'sailing kept too', topic: 1, minutesAgo: 117 });
    await message(thread, { text: 'sailing tool noise', topic: 1, minutesAgo: 116, role: 'tool' });

    const external = await conversation({ trust: 'external' });
    await message(external, { text: 'sailing from outside', topic: 1, minutesAgo: 120 });
    await message(external, { text: 'sailing from outside again', topic: 1, minutesAgo: 119 });
    const foreign = await conversation({ agent: randomUUID() });
    await message(foreign, { text: 'sailing elsewhere', topic: 1, minutesAgo: 120 });
    await message(foreign, { text: 'sailing elsewhere again', topic: 1, minutesAgo: 119 });

    await runJob();
    const rows = await segments(thread);
    expect(rows.map((row) => [row.startMessageId, row.messageCount])).toEqual([[first, 2]]);
    expect(await segments(external)).toEqual([]);
    expect(await segments(foreign)).toEqual([]);
    expect(summaries).toEqual(['Talked about sailing']);
  });

  it('records one segment when two runs commit the same start concurrently', async () => {
    const thread = await conversation({});
    const start = await message(thread, { text: 'sailing', topic: 1, minutesAgo: 60 });
    const end = await message(thread, { text: 'sailing more', topic: 1, minutesAgo: 59 });
    const repository = persistence.conversationSegmentation;
    if (!repository) throw new Error('missing segmentation repository');
    const input = {
      agentId,
      conversationId: thread,
      startMessageId: start,
      endMessageId: end,
      summary: 'Talked about sailing',
      embedding: axis(100),
      messageCount: 2,
      startedAt: at(60),
      endedAt: at(59),
    };
    const results = await Promise.all([
      repository.commitSegment(input),
      repository.commitSegment(input),
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect(await segments(thread)).toHaveLength(1);

    await expect(
      repository.commitSegment({ ...input, agentId: randomUUID(), startMessageId: end }),
    ).rejects.toThrow('outside the configured owner');
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'running' });
    await expect(repository.commitSegment({ ...input, startMessageId: end })).rejects.toThrow(
      'Privacy erasure is in progress',
    );
  });
});
