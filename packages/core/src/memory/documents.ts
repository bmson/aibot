import { createHash } from 'node:crypto';
import {
  type Db,
  type DocumentRow,
  documentChunks,
  documents,
  files,
  type TaskRow,
  tasks,
} from '@assistant/db';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { BudgetReservationError } from '../cost.js';
import type { ModelRouter } from '../model-router/router.js';
import { withSpan } from '../otel.js';
import { getQueueNotifier } from '../queue.js';
import { enqueueTask } from '../workflow/machine.js';
import type { WorkspaceReader } from './import.js';

/**
 * Document intelligence (Phase 11). An uploaded file or an attachment the
 * assistant auto-files from a trusted sender is promoted to a searchable
 * `documents` row; a resumable `documents.extract` code job pulls the bytes
 * from the workspace, extracts text, chunks it, embeds the chunks, and stores
 * them in `document_chunks` behind the `documents.search` tool.
 *
 * Extraction is deliberately split by weight: text-like formats and PDFs (with
 * a real text layer) are handled in-process with lightweight parsers; scans,
 * images, office, and audio are parked with `extractor='pending_processor'`
 * for the future document-processor worker (Phase 14) to pick up — the agent
 * container never loads heavyweight parsers for those.
 */

export type DocumentExtractor = 'text' | 'pdf' | 'pending_processor' | 'unsupported';
export type DocumentTrust = 'owner' | 'known' | 'unknown' | 'assistant';
export type DocumentSource = 'upload' | 'email' | 'drive';

const CHUNK_CHARS = 1200;
const CHUNK_OVERLAP = 150;
const MAX_CHUNKS = 4000; // bounds cost/runtime for a very large document
const CHUNKS_PER_RUN = 60; // one lease's worth, under the router's 100/embed-batch cap
const MAX_EXTRACT_BYTES = 40 * 1024 * 1024;
const MIN_PDF_TEXT_CHARS = 16; // below this a PDF is treated as a scan → needs OCR (Phase 14)
const RESUME_DELAY_MS = 3_000;
const DEFAULT_DOCUMENT_BUDGET_USD = '0.50';

const TEXT_LIKE_MIMES: ReadonlySet<string> = new Set([
  'application/json',
  'application/xml',
  'application/xhtml+xml',
  'application/csv',
  'application/x-ndjson',
  'application/x-yaml',
  'application/yaml',
  'application/markdown',
]);
const TEXT_LIKE_EXT =
  /\.(txt|md|markdown|csv|tsv|json|jsonl|ndjson|ya?ml|xml|html?|log|rst|org|tex|vtt|srt)$/i;
const CODE_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|c|h|cpp|cc|cs|php|sh|sql|css|scss|toml|ini|cfg|conf)$/i;
const PDF_MIME = 'application/pdf';
const PENDING_MIME_RE = /^(image|audio|video)\//;
const PENDING_MIMES: ReadonlySet<string> = new Set([
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/rtf',
]);

function baseMime(mime: string): string {
  return (mime || '').toLowerCase().split(';')[0]?.trim() ?? '';
}

/** Pick the extraction strategy from the mime type, falling back to the filename. */
export function extractorFor(mime: string, filename: string): DocumentExtractor {
  const m = baseMime(mime);
  const name = filename.toLowerCase();
  if (m === PDF_MIME || name.endsWith('.pdf')) return 'pdf';
  if (
    m.startsWith('text/') ||
    TEXT_LIKE_MIMES.has(m) ||
    TEXT_LIKE_EXT.test(name) ||
    CODE_EXT.test(name)
  ) {
    return 'text';
  }
  if (PENDING_MIME_RE.test(m) || PENDING_MIMES.has(m)) return 'pending_processor';
  return 'unsupported';
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
}

/** Extract plain text from the bytes. `unpdf` is imported lazily so the parser
 *  only loads when a PDF is actually processed. */
export async function extractDocumentText(
  extractor: DocumentExtractor,
  bytes: Buffer,
  mime: string,
): Promise<string> {
  if (extractor === 'pdf') {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: true });
    return (Array.isArray(text) ? text.join('\n') : text).trim();
  }
  const raw = bytes.toString('utf8');
  const isHtml = baseMime(mime).includes('html') || /<html[\s>]/i.test(raw.slice(0, 2000));
  return (isHtml ? stripHtml(raw) : raw).trim();
}

/**
 * Split text into overlapping chunks, preferring paragraph/sentence boundaries
 * near the target size so a chunk rarely severs a sentence. Deterministic —
 * the extraction job re-chunks the same text identically on each lease.
 */
export function chunkText(
  text: string,
  opts: { size?: number; overlap?: number; max?: number } = {},
): string[] {
  const size = opts.size ?? CHUNK_CHARS;
  const overlap = opts.overlap ?? CHUNK_OVERLAP;
  const max = opts.max ?? MAX_CHUNKS;
  const normalized = text
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!normalized) return [];
  const chunks: string[] = [];
  let i = 0;
  while (i < normalized.length && chunks.length < max) {
    let end = Math.min(i + size, normalized.length);
    if (end < normalized.length) {
      const window = normalized.slice(i, end);
      const para = window.lastIndexOf('\n\n');
      const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('.\n'));
      if (para > size * 0.5) end = i + para;
      else if (sentence > size * 0.5) end = i + sentence + 1;
    }
    const chunk = normalized.slice(i, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= normalized.length) break;
    i = Math.max(end - overlap, i + 1);
  }
  return chunks;
}

export function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ── Extraction code job ──────────────────────────────────────────────────────

interface DocumentExtractPayload {
  documentId: string;
}

function extractPayload(task: TaskRow): DocumentExtractPayload {
  const payload = (task.trigger as { payload?: Record<string, unknown> })?.payload ?? {};
  const documentId = String(payload.documentId ?? '');
  if (!documentId) throw new Error('document extract payload needs a documentId');
  return { documentId };
}

interface DocumentExtractCursor {
  index: number;
  total: number;
}

export interface DocumentExtractOutcome {
  done: boolean;
  runAfter?: Date;
  summary: string;
}

/**
 * Code job: extract, chunk, and embed one document. Resumable — the chunk
 * cursor checkpoints into tasks.state after every batch, the text re-chunks
 * deterministically on each lease, and inserts are idempotent on
 * (document_id, chunk_index), so a replayed batch is a no-op.
 */
export async function runDocumentExtraction(
  deps: {
    db: Db;
    router: ModelRouter;
    workspace?: WorkspaceReader;
    heartbeat?: () => Promise<void>;
  },
  task: TaskRow,
): Promise<DocumentExtractOutcome> {
  const { db, router, workspace } = deps;
  if (!workspace?.readBytes) {
    throw new Error('document extraction needs a workspace store with binary reads');
  }
  const readBytes = workspace.readBytes.bind(workspace);
  const { documentId } = extractPayload(task);

  return withSpan('documents.extract', { documentId }, async () => {
    await deps.heartbeat?.();
    const [doc] = await db.select().from(documents).where(eq(documents.id, documentId));
    if (!doc) return { done: true, summary: `document ${documentId}: gone — nothing to do` };
    if (doc.status === 'ready') {
      return { done: true, summary: `document ${doc.title}: already extracted` };
    }
    const [file] = await db.select().from(files).where(eq(files.id, doc.fileId));
    if (!file) {
      await failDocument(db, documentId, 'backing file missing');
      return { done: true, summary: `document ${doc.title}: backing file missing` };
    }

    const extractor = (doc.extractor || extractorFor(doc.mime, doc.title)) as DocumentExtractor;

    let fullText: string;
    if (extractor === 'pending_processor') {
      // Handed to the document-processor worker (Phase 14). Once it has uploaded
      // the extracted text and its callback set processedTextPath, chunk+embed it
      // here through the same pipeline as in-process formats. Until then there is
      // nothing to do — the processor sweep owns the launch.
      if (!doc.processedTextPath) {
        return { done: true, summary: `document ${doc.title}: awaiting document processor` };
      }
      const textBytes = await readBytes(doc.processedTextPath);
      await deps.heartbeat?.();
      fullText = textBytes.toString('utf8').trim();
    } else if (extractor === 'unsupported') {
      await db
        .update(documents)
        .set({ status: 'unsupported', extractor, updatedAt: sql`now()` })
        .where(eq(documents.id, documentId));
      return { done: true, summary: `document ${doc.title}: unsupported` };
    } else {
      if ((file.bytes ?? 0) > MAX_EXTRACT_BYTES) {
        await failDocument(db, documentId, `too large to extract in-process (${file.bytes} bytes)`);
        return { done: true, summary: `document ${doc.title}: too large` };
      }
      const bytes = await readBytes(file.workspacePath);
      await deps.heartbeat?.();
      fullText = await extractDocumentText(extractor, bytes, doc.mime);

      // A PDF with (almost) no text layer is a scan → hand it to the OCR-capable
      // document processor (Phase 14) instead of storing an empty document.
      if (extractor === 'pdf' && fullText.length < MIN_PDF_TEXT_CHARS) {
        await db
          .update(documents)
          .set({ status: 'pending', extractor: 'pending_processor', updatedAt: sql`now()` })
          .where(eq(documents.id, documentId));
        return { done: true, summary: `document ${doc.title}: no text layer — queued for OCR` };
      }
    }

    const chunks = chunkText(fullText);
    const charCount = fullText.length;
    if (chunks.length === 0) {
      await db
        .update(documents)
        .set({
          status: 'ready',
          extractor,
          chunkCount: 0,
          charCount,
          error: null,
          updatedAt: sql`now()`,
        })
        .where(eq(documents.id, documentId));
      return { done: true, summary: `document ${doc.title}: empty` };
    }

    const state = (task.state ?? {}) as Record<string, unknown>;
    const plannerState = (state.plannerState ?? {}) as Record<string, unknown>;
    const cursor: DocumentExtractCursor = {
      index: 0,
      total: chunks.length,
      ...((plannerState.documentExtract as Partial<DocumentExtractCursor>) ?? {}),
    };

    // First lease claims the document and clears any stale chunks so a re-run
    // (e.g. after an edit) never leaves orphaned chunks behind.
    if (cursor.index === 0) {
      await db.delete(documentChunks).where(eq(documentChunks.documentId, documentId));
      await db
        .update(documents)
        .set({ status: 'extracting', extractor, error: null, updatedAt: sql`now()` })
        .where(eq(documents.id, documentId));
    }

    const checkpoint = async () => {
      await deps.heartbeat?.();
      plannerState.documentExtract = cursor;
      state.plannerState = plannerState;
      await db
        .update(tasks)
        .set({
          state,
          progress: `extract ${doc.title}: ${cursor.index}/${cursor.total} chunks`,
          progressPercent: cursor.total
            ? Math.min(100, Math.round((cursor.index / cursor.total) * 100))
            : 100,
          reclaimCount: 0,
          updatedAt: sql`now()`,
        })
        .where(eq(tasks.id, task.id));
    };

    const stopAt = Math.min(cursor.index + CHUNKS_PER_RUN, chunks.length);
    while (cursor.index < stopAt) {
      const start = cursor.index;
      const batch = chunks.slice(start, stopAt);
      let embeddings: number[][];
      try {
        embeddings = await router.embed(batch, { taskId: task.id });
      } catch (err) {
        if (err instanceof BudgetReservationError) {
          await checkpoint();
          await failDocument(db, documentId, err.message.slice(0, 2000), { keepStatus: true });
        }
        throw err;
      }
      await deps.heartbeat?.();
      await db
        .insert(documentChunks)
        .values(
          batch.map((text, i) => ({
            documentId,
            agentId: doc.agentId,
            chunkIndex: start + i,
            text,
            charCount: text.length,
            embedding: embeddings[i],
          })),
        )
        .onConflictDoNothing({
          target: [documentChunks.documentId, documentChunks.chunkIndex],
        });
      cursor.index = stopAt;
      await checkpoint();
    }

    if (cursor.index >= chunks.length) {
      await db
        .update(documents)
        .set({
          status: 'ready',
          extractor,
          chunkCount: chunks.length,
          charCount,
          error: null,
          updatedAt: sql`now()`,
        })
        .where(eq(documents.id, documentId));
      return {
        done: true,
        summary: `document ${doc.title}: extracted ${chunks.length} chunks (${charCount} chars)`,
      };
    }
    return {
      done: false,
      runAfter: new Date(Date.now() + RESUME_DELAY_MS),
      summary: `document ${doc.title}: ${cursor.index}/${chunks.length} chunks`,
    };
  });
}

async function failDocument(
  db: Db,
  documentId: string,
  error: string,
  opts: { keepStatus?: boolean } = {},
): Promise<void> {
  await db
    .update(documents)
    .set({
      ...(opts.keepStatus ? {} : { status: 'failed' }),
      error: error.slice(0, 2000),
      updatedAt: sql`now()`,
    })
    .where(eq(documents.id, documentId));
}

// ── Search (used by the documents.search tool + dashboard) ───────────────────

export interface DocumentSearchHit {
  documentId: string;
  title: string;
  source: string;
  trust: string;
  chunkIndex: number;
  text: string;
  similarity: number;
}

/** Cosine-nearest document chunks across the agent's ready documents. */
export async function searchDocumentChunks(
  db: Db,
  input: { agentId: string; embedding: number[]; limit: number; documentId?: string },
): Promise<DocumentSearchHit[]> {
  const vec = JSON.stringify(input.embedding);
  const filters = [eq(documentChunks.agentId, input.agentId), eq(documents.status, 'ready')];
  if (input.documentId) filters.push(eq(documentChunks.documentId, input.documentId));
  return db
    .select({
      documentId: documentChunks.documentId,
      title: documents.title,
      source: documents.source,
      trust: documents.trust,
      chunkIndex: documentChunks.chunkIndex,
      text: documentChunks.text,
      similarity: sql<number>`1 - (${documentChunks.embedding} <=> ${vec}::vector)`,
    })
    .from(documentChunks)
    .innerJoin(documents, eq(documents.id, documentChunks.documentId))
    .where(and(...filters))
    .orderBy(sql`${documentChunks.embedding} <=> ${vec}::vector`)
    .limit(input.limit);
}

// ── Lifecycle (dashboard + triage entry points) ──────────────────────────────

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
 * File a document: create its files-inventory row and documents row, and — for
 * in-process formats — enqueue the resumable extraction job. Deduplicates on
 * (agentId, sha256): re-filing identical bytes returns the existing document
 * without re-extracting. Heavy formats are recorded `pending`/`pending_processor`
 * (awaiting Phase 14) or `unsupported`, with no job enqueued.
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

    const [doc] = await tx
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
    if (!doc) throw new Error('failed to create document row');

    // text/pdf are extracted in-process; heavy formats are handed to the
    // out-of-process document-processor worker (Phase 14). Unsupported enqueues
    // nothing.
    const job =
      extractor === 'text' || extractor === 'pdf'
        ? 'documents.extract'
        : extractor === 'pending_processor'
          ? 'documents.process'
          : null;
    if (!job) return { document: doc, task: null as EnqueuedTask | null, duplicate: false };

    const { task } = await enqueueTask(txDb, {
      event: {
        source: 'internal',
        agentId: input.agentId,
        trust: 'assistant',
        payload: { job, documentId: doc.id },
      },
      type: 'adhoc',
      budgetUsdLimit:
        job === 'documents.process'
          ? '0.05'
          : (input.budgetUsdLimit ?? DEFAULT_DOCUMENT_BUDGET_USD),
      deferNotification: true,
    });
    return {
      document: doc,
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
  return rows.map((r) => ({ ...r, bytes: r.bytes ?? 0 }));
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

/**
 * Delete a document: cancel any in-flight extraction, remove its chunks, the
 * document row, its file-inventory row, and the workspace bytes.
 */
export async function purgeDocument(
  db: Db,
  agentId: string,
  documentId: string,
  workspace?: { delete(relPath: string): Promise<void> },
): Promise<{ deleted: boolean }> {
  const [doc] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.agentId, agentId)));
  if (!doc) return { deleted: false };
  const [file] = await db.select().from(files).where(eq(files.id, doc.fileId));

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
    await tx.delete(files).where(eq(files.id, doc.fileId));
  });

  if (workspace && file) {
    await workspace.delete(file.workspacePath).catch((err) => {
      console.error(`document purge: workspace delete failed for ${file.workspacePath}`, err);
    });
  }
  // The document-processor worker's extracted-text blob (Phase 14) lives outside
  // the files inventory, so purge it explicitly.
  if (workspace && doc.processedTextPath) {
    await workspace.delete(doc.processedTextPath).catch((err) => {
      console.error(`document purge: text-blob delete failed for ${doc.processedTextPath}`, err);
    });
  }
  return { deleted: true };
}
