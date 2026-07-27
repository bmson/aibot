import { type Db, type DocumentRow, documentChunks, documents, files, tasks } from '@assistant/db';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { getQueueNotifier } from '../queue.js';
import { enqueueTask } from '../workflow/machine.js';
import { type DocumentSource, type DocumentTrust, extractorFor } from './document-types.js';

const DEFAULT_DOCUMENT_BUDGET_USD = '0.50';

export interface StartDocumentInput {
  agentId: string;
  title: string;
  workspacePath: string;
  mime: string;
  bytes: number;
  sha256: string;
  source?: DocumentSource;
  sourceRef?: string;
  trust?: DocumentTrust;
  budgetUsdLimit?: string;
}

export interface StartDocumentResult {
  document: DocumentRow;
  taskId: string | null;
  duplicate: boolean;
}

/**
 * File a document and enqueue its bounded extraction job. The catalog owns
 * durable lifecycle operations but does not import any parser implementation,
 * keeping dashboard routes free of PDF/Office runtime dependencies.
 */
export async function startDocumentIngest(
  db: Db,
  input: StartDocumentInput,
): Promise<StartDocumentResult> {
  const extractor = extractorFor(input.mime, input.title);
  const status = extractor === 'unsupported' ? 'unsupported' : 'pending';

  type EnqueuedTask = { id: string; queueGeneration: number };
  const result = await db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const [existing] = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.agentId, input.agentId), eq(documents.sha256, input.sha256)))
      .limit(1);
    if (existing) {
      return { document: existing, task: null as EnqueuedTask | null, duplicate: true };
    }

    const [file] = await tx
      .insert(files)
      .values({
        agentId: input.agentId,
        workspacePath: input.workspacePath,
        mime: input.mime,
        bytes: input.bytes,
        sha256: input.sha256,
      })
      .returning();
    if (!file) throw new Error('failed to create file row for document');

    const [document] = await tx
      .insert(documents)
      .values({
        agentId: input.agentId,
        fileId: file.id,
        title: input.title.slice(0, 300),
        mime: input.mime,
        source: input.source ?? 'upload',
        sourceRef: input.sourceRef ?? '',
        trust: input.trust ?? 'owner',
        sha256: input.sha256,
        status,
        extractor,
      })
      .returning();
    if (!document) throw new Error('failed to create document row');

    const job =
      extractor === 'text' || extractor === 'pdf'
        ? 'documents.extract'
        : extractor === 'pending_processor'
          ? 'documents.process'
          : null;
    if (!job) {
      return { document, task: null as EnqueuedTask | null, duplicate: false };
    }

    const { task } = await enqueueTask(txDb, {
      event: {
        source: 'internal',
        agentId: input.agentId,
        trust: 'assistant',
        payload: { job, documentId: document.id },
      },
      type: 'adhoc',
      budgetUsdLimit:
        job === 'documents.process'
          ? '0.05'
          : (input.budgetUsdLimit ?? DEFAULT_DOCUMENT_BUDGET_USD),
      deferNotification: true,
    });
    return {
      document,
      task: { id: task.id, queueGeneration: task.queueGeneration },
      duplicate: false,
    };
  });

  if (result.task) getQueueNotifier().notify(result.task.id, result.task.queueGeneration);
  return {
    document: result.document,
    taskId: result.task?.id ?? null,
    duplicate: result.duplicate,
  };
}

export interface DocumentView {
  id: string;
  title: string;
  mime: string;
  source: string;
  trust: string;
  status: string;
  extractor: string;
  chunkCount: number;
  charCount: number;
  bytes: number;
  error: string | null;
  createdAt: Date;
}

export async function listDocuments(db: Db, agentId: string): Promise<DocumentView[]> {
  const rows = await db
    .select({
      id: documents.id,
      title: documents.title,
      mime: documents.mime,
      source: documents.source,
      trust: documents.trust,
      status: documents.status,
      extractor: documents.extractor,
      chunkCount: documents.chunkCount,
      charCount: documents.charCount,
      bytes: files.bytes,
      error: documents.error,
      createdAt: documents.createdAt,
    })
    .from(documents)
    .innerJoin(files, eq(files.id, documents.fileId))
    .where(eq(documents.agentId, agentId))
    .orderBy(desc(documents.createdAt))
    .limit(200);
  return rows.map((row) => ({ ...row, bytes: row.bytes ?? 0 }));
}

export interface DocumentStats {
  total: number;
  ready: number;
  pending: number;
  chunks: number;
}

export async function documentStats(db: Db, agentId: string): Promise<DocumentStats> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)`,
      ready: sql<number>`count(*) filter (where ${documents.status} = 'ready')`,
      pending: sql<number>`count(*) filter (where ${documents.status} in ('pending','extracting'))`,
      chunks: sql<number>`coalesce(sum(${documents.chunkCount}), 0)`,
    })
    .from(documents)
    .where(eq(documents.agentId, agentId));
  return {
    total: Number(row?.total ?? 0),
    ready: Number(row?.ready ?? 0),
    pending: Number(row?.pending ?? 0),
    chunks: Number(row?.chunks ?? 0),
  };
}

/** Remove a document, its in-flight jobs, inventory, chunks, and stored bytes. */
export async function purgeDocument(
  db: Db,
  agentId: string,
  documentId: string,
  workspace?: { delete(relativePath: string): Promise<void> },
): Promise<{ deleted: boolean }> {
  const [document] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.agentId, agentId)));
  if (!document) return { deleted: false };
  const [file] = await db.select().from(files).where(eq(files.id, document.fileId));

  await db.transaction(async (tx) => {
    await tx
      .update(tasks)
      .set({ status: 'cancelled', lockedUntil: null, runAfter: null, updatedAt: sql`now()` })
      .where(
        and(
          sql`${tasks.trigger}->'payload'->>'job' IN ('documents.extract','documents.process')`,
          sql`${tasks.trigger}->'payload'->>'documentId' = ${documentId}`,
          inArray(tasks.status, ['pending', 'sleeping', 'running', 'needs_attention']),
        ),
      );
    await tx.delete(documentChunks).where(eq(documentChunks.documentId, documentId));
    await tx.delete(documents).where(eq(documents.id, documentId));
    await tx.delete(files).where(eq(files.id, document.fileId));
  });

  if (workspace && file) {
    await workspace.delete(file.workspacePath).catch((error) => {
      console.error(`document purge: workspace delete failed for ${file.workspacePath}`, error);
    });
  }
  if (workspace && document.processedTextPath) {
    await workspace.delete(document.processedTextPath).catch((error) => {
      console.error(
        `document purge: text-blob delete failed for ${document.processedTextPath}`,
        error,
      );
    });
  }
  return { deleted: true };
}
