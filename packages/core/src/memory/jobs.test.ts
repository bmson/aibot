import { createDb, type Db, type TaskRow, tasks } from '@assistant/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../chat.js';
import { loadConfig, resetConfigForTest } from '../config.js';
import type { InboundEvent } from '../events.js';
import type { ModelRouter } from '../model-router/router.js';
import type { DispatcherPort } from '../workflow/executor.js';
import { executeTask } from '../workflow/executor.js';
import { enqueueTask } from '../workflow/machine.js';
import { codeJobName, isCodeJobEnabled, runCodeJob } from './jobs.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

let db: Db;
let dbUp = false;
let agentId: string;
const createdTaskIds: string[] = [];

/** Extraction with no extractable conversations returns empty — the fake never gets called for facts. */
const fakeRouter = {
  async object() {
    return {
      ok: true,
      modelId: 'fake',
      degraded: false,
      object: { facts: [], commitments: [], resolvedTitles: [] },
    };
  },
  async embed(texts: string[]) {
    return texts.map(() => new Array(1536).fill(0.01));
  },
} as unknown as ModelRouter;

/** Code jobs must never reach the tool dispatcher. */
const explodingDispatcher: DispatcherPort = {
  toolDefs: () => {
    throw new Error('code job must not build a tool set');
  },
  resultIsUntrusted: () => false,
  dispatch: async () => {
    throw new Error('code job must not dispatch tools');
  },
  executeApproved: async () => {
    throw new Error('code job must not execute approvals');
  },
};

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    agentId = (await getAgent(db)).id;
    dbUp = true;
  } catch {
    console.warn('jobs.test: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp && createdTaskIds.length) {
    await db.delete(tasks).where(inArray(tasks.id, createdTaskIds));
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

afterEach(() => resetConfigForTest());

describe('codeJobName', () => {
  const taskWith = (payload: Record<string, unknown>) =>
    ({ trigger: { source: 'schedule', payload } }) as never;
  it('recognizes registered jobs and rejects everything else', () => {
    expect(codeJobName(taskWith({ job: 'memory.extract' }))).toBe('memory.extract');
    expect(codeJobName(taskWith({ job: 'memory.consolidate' }))).toBe('memory.consolidate');
    expect(codeJobName(taskWith({ job: 'memory.graph_sync' }))).toBe('memory.graph_sync');
    expect(codeJobName(taskWith({ job: 'memory.graph_date_backfill' }))).toBe(
      'memory.graph_date_backfill',
    );
    expect(codeJobName(taskWith({ job: 'voice.ingest' }))).toBe('voice.ingest');
    expect(codeJobName(taskWith({ job: 'documents.extract' }))).toBe('documents.extract');
    expect(codeJobName(taskWith({ job: 'documents.process' }))).toBe('documents.process');
    expect(codeJobName(taskWith({ job: 'ambient.refresh' }))).toBe('ambient.refresh');
    expect(codeJobName(taskWith({ job: 'dream.run' }))).toBe('dream.run');
    expect(codeJobName(taskWith({ job: 'self.maintain' }))).toBe('self.maintain');
    expect(codeJobName(taskWith({ job: 'health.monitor' }))).toBe('health.monitor');
    expect(codeJobName(taskWith({ job: 'rm -rf /' }))).toBeNull();
    expect(codeJobName(taskWith({ instruction: 'do things' }))).toBeNull();
    expect(codeJobName({ trigger: null } as never)).toBeNull();
  });
});

describe('feature-gated code jobs', () => {
  it('skips graph sync until GraphRAG is explicitly enabled', async () => {
    loadConfig({ GRAPH_RAG_ENABLED: 'false' });
    expect(isCodeJobEnabled('memory.graph_sync')).toBe(false);
    expect(isCodeJobEnabled('memory.extract')).toBe(true);

    const result = await runCodeJob({ db: {} as Db, router: fakeRouter }, 'memory.graph_sync', {
      id: 'unused',
      agentId: 'unused',
    } as TaskRow);
    expect(result).toEqual({ done: true, summary: 'knowledge graph: disabled' });
  });

  // The date backfill reads the graph, so it is gated on the same flag even
  // though it never spends anything.
  it('gates the date backfill behind the same flag', async () => {
    loadConfig({ GRAPH_RAG_ENABLED: 'false' });
    expect(isCodeJobEnabled('memory.graph_date_backfill')).toBe(false);

    const result = await runCodeJob(
      { db: {} as Db, router: fakeRouter },
      'memory.graph_date_backfill',
      { id: 'unused', agentId: 'unused' } as TaskRow,
    );
    expect(result).toEqual({ done: true, summary: 'knowledge graph dates: disabled' });
  });
});

describe('code job execution (integration)', () => {
  it('a scheduled task with a job payload runs the job, not the model loop', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const event: InboundEvent = {
      source: 'schedule',
      agentId,
      trust: 'assistant',
      payload: { schedule: 'memory-extraction', job: 'memory.extract' },
    };
    const { task } = await enqueueTask(db, { event, type: 'scheduled' });
    createdTaskIds.push(task.id);

    const result = await executeTask(
      { db, router: fakeRouter, dispatcher: explodingDispatcher },
      task.id,
    );
    expect(result.outcome).toBe('done');

    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row?.status).toBe('done');
    expect(row?.progress).toMatch(/^extraction:/);
  });
});
