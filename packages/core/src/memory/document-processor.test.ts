import { randomUUID } from 'node:crypto';
import {
  createDb,
  type Db,
  documentChunks,
  documents,
  files,
  type TaskRow,
  tasks,
} from '@assistant/db';
import { and, eq, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../chat.js';
import {
  type DocumentJobLaunchInput,
  type DocumentProcessorLauncher,
  extractedTextPath,
  recordDocumentProcessorResult,
  runDocumentProcessing,
} from './document-processor.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

/** A launcher that records every launch and hands back the plaintext token so the
 *  test can drive the callback the worker would otherwise make. */
function fakeLauncher() {
  const launches: DocumentJobLaunchInput[] = [];
  const launcher: DocumentProcessorLauncher = {
    async launch(input) {
      launches.push(input);
      return { executionName: `fake-${launches.length}` };
    },
  };
  return { launcher, launches };
}

const sweepTask = (payload: Record<string, unknown>) =>
  ({ trigger: { source: 'schedule', payload } }) as unknown as TaskRow;

describe('document processor — sweep + callback', () => {
  let db: Db;
  let dbUp = false;
  let agentId: string;

  async function cleanup() {
    const docs = await db
      .select({ id: documents.id })
      .from(documents)
      .where(like(documents.title, 'XTESTPROC%'));
    for (const d of docs) {
      await db.delete(documentChunks).where(eq(documentChunks.documentId, d.id));
      await db.delete(tasks).where(sql`${tasks.trigger}->'payload'->>'documentId' = ${d.id}`);
    }
    if (docs.length) {
      await db.delete(documents).where(like(documents.title, 'XTESTPROC%'));
      await db.delete(files).where(like(files.workspacePath, 'documents/xtestproc/%'));
    }
  }

  /** Insert a heavy-format document parked for the processor (no ingest task). */
  async function makeDoc(title: string): Promise<string> {
    const [file] = await db
      .insert(files)
      .values({
        agentId,
        workspacePath: `documents/xtestproc/${randomUUID()}.docx`,
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        bytes: 20,
        sha256: randomUUID(),
      })
      .returning();
    const [doc] = await db
      .insert(documents)
      .values({
        agentId,
        fileId: file?.id ?? '',
        title,
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        source: 'upload',
        trust: 'owner',
        sha256: randomUUID(),
        status: 'pending',
        extractor: 'pending_processor',
      })
      .returning();
    return doc?.id ?? '';
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    try {
      agentId = (await getAgent(db)).id;
      dbUp = true;
      await cleanup();
    } catch {
      console.warn('document-processor.test: database unreachable — skipping');
    }
  });

  afterAll(async () => {
    if (dbUp) await cleanup();
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
  });

  it('is inert when no processor is configured — pending docs are left untouched', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const id = await makeDoc('XTESTPROC inert');
    const r = await runDocumentProcessing({ db }, sweepTask({ documentId: id }));
    expect(r.done).toBe(true);
    expect(r.summary).toMatch(/not configured/);
    const [doc] = await db.select().from(documents).where(eq(documents.id, id));
    expect(doc?.processorStartedAt).toBeNull();
    expect(doc?.processorTokenHash).toBeNull();
  });

  it('claims + launches a pending doc exactly once (no double-launch on a fresh claim)', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const id = await makeDoc('XTESTPROC launch');
    const { launcher, launches } = fakeLauncher();
    const deps = { db, documentProcessor: { launcher, callbackUrl: 'http://cb/document' } };

    const first = await runDocumentProcessing(deps, sweepTask({ documentId: id }));
    expect(first.summary).toMatch(/1 launched/);
    expect(launches).toHaveLength(1);
    expect(launches[0]?.documentId).toBe(id);
    expect(launches[0]?.outputPath).toBe(extractedTextPath(id));
    expect(launches[0]?.callbackToken).toBeTruthy();

    const [claimed] = await db.select().from(documents).where(eq(documents.id, id));
    expect(claimed?.processorTokenHash).toBeTruthy();
    expect(claimed?.processorStartedAt).not.toBeNull();

    // A second sweep while the claim is fresh must not relaunch.
    const second = await runDocumentProcessing(deps, sweepTask({ documentId: id }));
    expect(launches).toHaveLength(1);
    expect(second.summary).toMatch(/0 launched/);
  });

  it('success callback points the extract pipeline at the text blob and wakes it', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const id = await makeDoc('XTESTPROC success');
    const { launcher, launches } = fakeLauncher();
    await runDocumentProcessing(
      { db, documentProcessor: { launcher, callbackUrl: 'http://cb/document' } },
      sweepTask({ documentId: id }),
    );
    const token = launches[0]?.callbackToken ?? '';

    const outcome = await recordDocumentProcessorResult(db, {
      documentId: id,
      token,
      result: { ok: true, kind: 'text', chars: 1200 },
    });
    expect(outcome.ok).toBe(true);

    const [doc] = await db.select().from(documents).where(eq(documents.id, id));
    expect(doc?.processedTextPath).toBe(extractedTextPath(id));
    expect(doc?.processorTokenHash).toBeNull(); // one-shot: cleared on settle
    expect(doc?.status).toBe('pending'); // extract job takes it to ready

    // A documents.extract job was enqueued for the chunk+embed pass.
    const [extractTask] = await db
      .select()
      .from(tasks)
      .where(
        and(
          sql`${tasks.trigger}->'payload'->>'job' = 'documents.extract'`,
          sql`${tasks.trigger}->'payload'->>'documentId' = ${id}`,
        ),
      );
    expect(extractTask).toBeTruthy();

    // Replaying the same token after settle is rejected (no pending run).
    const replay = await recordDocumentProcessorResult(db, {
      documentId: id,
      token,
      result: { ok: true, kind: 'text', chars: 1200 },
    });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.status).toBe(409);
  });

  it('rejects a forged token before settle (403) and an unknown document (404)', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const id = await makeDoc('XTESTPROC forged');
    const { launcher } = fakeLauncher();
    await runDocumentProcessing(
      { db, documentProcessor: { launcher, callbackUrl: 'http://cb/document' } },
      sweepTask({ documentId: id }),
    );

    const forged = await recordDocumentProcessorResult(db, {
      documentId: id,
      token: 'not-the-real-token',
      result: { ok: true, kind: 'text', chars: 10 },
    });
    expect(forged.ok).toBe(false);
    if (!forged.ok) expect(forged.status).toBe(403);

    const missing = await recordDocumentProcessorResult(db, {
      documentId: randomUUID(),
      token: 'x',
      result: { ok: true },
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.status).toBe(404);
  });

  it('marks a document unsupported when the worker cannot parse it — no extract job', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const id = await makeDoc('XTESTPROC unsupported');
    const { launcher, launches } = fakeLauncher();
    await runDocumentProcessing(
      { db, documentProcessor: { launcher, callbackUrl: 'http://cb/document' } },
      sweepTask({ documentId: id }),
    );
    const token = launches[0]?.callbackToken ?? '';

    const outcome = await recordDocumentProcessorResult(db, {
      documentId: id,
      token,
      result: { ok: false, kind: 'unsupported', error: 'no parser for image/png' },
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.enqueued).toBe(false);

    const [doc] = await db.select().from(documents).where(eq(documents.id, id));
    expect(doc?.status).toBe('unsupported');
    expect(doc?.processorTokenHash).toBeNull();
    expect(doc?.error).toMatch(/no parser/);
  });
});
