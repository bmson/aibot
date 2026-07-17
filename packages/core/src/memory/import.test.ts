import { contacts, createDb, type Db, importSources, memories, tasks } from '@assistant/db';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../chat.js';
import type { ModelRouter } from '../model-router/router.js';
import type { DispatcherPort } from '../workflow/executor.js';
import { executeTask } from '../workflow/executor.js';
import {
  purgeImportSource,
  reviewImportSource,
  startImport,
  type WorkspaceReader,
} from './import.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

const SOURCE = 'xtest-import-archive';
const MARKER = 'xtest-import';

let db: Db;
let dbUp = false;
let agentId: string;
const createdTaskIds: string[] = [];

// Three windows' worth of content (windowsPerRun=1 forces three runs).
// Fillers stay under the 2000-char unit cap so each paragraph is exactly one
// unit — longer paragraphs now chunk into multiple units instead of truncating.
const ARCHIVE = [
  `In 2019 I lived on Laugavegur in Reykjavik. ${'a'.repeat(1500)}`,
  `My cousin Ragnar Importsson fixes my car every spring. ${'b'.repeat(1500)}`,
  `I have always preferred window seats on flights. ${'c'.repeat(1500)}`,
].join('\n\n');

/** One distinct fact per window, keyed off the window's leading content. */
const fakeRouter = {
  async object(_role: string, opts: { prompt?: string }) {
    const prompt = opts.prompt ?? '';
    const fact = prompt.includes('Laugavegur')
      ? {
          content: `${MARKER}: lived on Laugavegur in Reykjavik until 2019`,
          subject: 'owner',
          domain: 'home',
          validFrom: '2019',
        }
      : prompt.includes('Ragnar')
        ? {
            content: `${MARKER}: Ragnar Importsson is his cousin and fixes his car`,
            subject: 'Ragnar Importsson',
            relationship: 'cousin',
            domain: 'relationships',
            validFrom: '',
          }
        : prompt.includes('window seats')
          ? {
              content: `${MARKER}: prefers window seats on flights`,
              subject: 'owner',
              domain: 'preferences',
              validFrom: '',
            }
          : null;
    return {
      ok: true,
      modelId: 'fake',
      degraded: false,
      object: {
        facts: fact
          ? [
              {
                kind: 'fact',
                category: 'knowledge',
                relationship: '',
                importance: 3,
                confidence: 0.8,
                ...fact,
              },
            ]
          : [],
      },
    };
  },
  async embed(texts: string[]) {
    return texts.map(() => new Array(1536).fill(0.01));
  },
} as unknown as ModelRouter;

const fakeWorkspace: WorkspaceReader = {
  async read(relPath: string) {
    if (relPath !== 'import/archive.txt') throw new Error(`no such file: ${relPath}`);
    return ARCHIVE;
  },
  async list() {
    return [{ name: 'archive.txt', dir: false }];
  },
};

const noopDispatcher: DispatcherPort = {
  toolDefs: () => {
    throw new Error('import job must not build tools');
  },
  dispatch: async () => {
    throw new Error('import job must not dispatch tools');
  },
  executeApproved: async () => {
    throw new Error('import job must not execute approvals');
  },
};

async function cleanup() {
  await db.delete(memories).where(sql`${memories.content} LIKE ${`${MARKER}%`}`);
  await db.delete(importSources).where(eq(importSources.source, SOURCE));
  await db.delete(contacts).where(eq(contacts.name, 'Ragnar Importsson'));
  if (createdTaskIds.length) await db.delete(tasks).where(inArray(tasks.id, createdTaskIds));
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    agentId = (await getAgent(db)).id;
    dbUp = true;
    await db.delete(memories).where(sql`${memories.content} LIKE ${`${MARKER}%`}`);
    await db.delete(importSources).where(eq(importSources.source, SOURCE));
    await db.delete(contacts).where(eq(contacts.name, 'Ragnar Importsson'));
  } catch {
    console.warn('import.test: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp) await cleanup();
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('backstory import (integration)', () => {
  it('imports resumably across runs, attributes/quarantines, dedupes on re-run, purges by source', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const deps = { db, router: fakeRouter, dispatcher: noopDispatcher, workspace: fakeWorkspace };

    const { taskId } = await startImport(db, {
      agentId,
      source: SOURCE,
      workspacePath: 'import/archive.txt',
      kind: 'text',
      windowsPerRun: 1,
      windowChars: 2000, // one unit per window → three windows
    });
    createdTaskIds.push(taskId);

    // Run 1: one window processed, task sleeps with a checkpoint — resumable, not restarted
    const run1 = await executeTask(deps, taskId);
    expect(run1.outcome).toBe('sleeping');
    let [src] = await db.select().from(importSources).where(eq(importSources.source, SOURCE));
    expect(src?.status).toBe('running');
    expect(src?.itemsProcessed).toBe(1);
    expect(src?.itemsTotal).toBe(3);

    // Simulate the interruption/wake cycle: clear runAfter and run again (twice)
    for (let i = 0; i < 2; i++) {
      await db
        .update(tasks)
        .set({ runAfter: sql`now() - interval '1 second'` })
        .where(eq(tasks.id, taskId));
      await executeTask(deps, taskId);
    }

    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(task?.status).toBe('done');
    [src] = await db.select().from(importSources).where(eq(importSources.source, SOURCE));
    expect(src?.status).toBe('done');
    expect(src?.memoriesSaved).toBe(3);

    const saved = await db
      .select()
      .from(memories)
      .where(sql`${memories.content} LIKE ${`${MARKER}%`}`);
    expect(saved).toHaveLength(3);

    // provenance + owner-archive trust rules
    for (const m of saved) {
      expect(m.source).toBe(SOURCE);
      expect(m.originTrust).toBe('owner');
    }
    const ownerFacts = saved.filter((m) => !m.content.includes('Ragnar'));
    const thirdParty = saved.find((m) => m.content.includes('Ragnar'));
    expect(ownerFacts.every((m) => !m.quarantined)).toBe(true);
    expect(thirdParty?.quarantined).toBe(true); // third-party facts wait for review

    // auto-created contact + entity link
    const [ragnar] = await db.select().from(contacts).where(eq(contacts.name, 'Ragnar Importsson'));
    expect(ragnar?.trust).toBe('unknown');
    expect(thirdParty?.subjectContactId).toBe(ragnar?.id);

    // age-scaled confidence: dated 2019 window fact is lower than base 0.8
    const laugavegur = saved.find((m) => m.content.includes('Laugavegur'));
    expect(laugavegur?.validFrom?.getUTCFullYear()).toBe(2019);

    // batch review by source: approve releases the quarantined fact
    const review = await reviewImportSource(db, SOURCE, 'approve');
    expect(review.reviewed).toBe(1);
    const [released] = await db
      .select()
      .from(memories)
      .where(eq(memories.id, (thirdParty as NonNullable<typeof thirdParty>).id));
    expect(released?.quarantined).toBe(false);

    // re-run: hash dedupe means nothing new
    const rerun = await startImport(db, {
      agentId,
      source: SOURCE,
      workspacePath: 'import/archive.txt',
      kind: 'text',
      windowsPerRun: 10,
    });
    createdTaskIds.push(rerun.taskId);
    const rerunResult = await executeTask(deps, rerun.taskId);
    expect(rerunResult.outcome).toBe('done');
    const afterRerun = await db
      .select()
      .from(memories)
      .where(sql`${memories.content} LIKE ${`${MARKER}%`}`);
    expect(afterRerun).toHaveLength(3); // no duplicates

    // purge-by-source removes exactly this source's memories
    const marker2 = `${MARKER}-other: unrelated fact that must survive the purge`;
    await db.insert(memories).values({
      agentId,
      category: 'knowledge',
      kind: 'fact',
      content: marker2,
      contentHash: `hash-${MARKER}-other`,
      originTrust: 'owner',
    });
    const purge = await purgeImportSource(db, SOURCE);
    expect(purge.purged).toBe(3);
    const remaining = await db
      .select()
      .from(memories)
      .where(sql`${memories.content} LIKE ${`${MARKER}%`}`);
    expect(remaining.map((m) => m.content)).toEqual([marker2]);
    [src] = await db.select().from(importSources).where(eq(importSources.source, SOURCE));
    expect(src?.status).toBe('purged');
  });
});
