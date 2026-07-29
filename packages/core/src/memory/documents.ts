import { createHash } from 'node:crypto';
import { type Db, documentChunks, documents, files, type TaskRow, tasks } from '@assistant/db';
import { and, eq, sql } from 'drizzle-orm';
import { BudgetReservationError } from '../cost.js';
import type { ModelRouter } from '../model-router/router.js';
import { withSpan } from '../otel.js';
import { baseMime, type DocumentExtractor, extractorFor } from './document-types.js';
import type { WorkspaceReader } from './import.js';

export * from './document-catalog.js';
export * from './document-types.js';

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

const CHUNK_CHARS = 1200;
const CHUNK_OVERLAP = 150;
const MAX_CHUNKS = 4000; // bounds cost/runtime for a very large document
const CHUNKS_PER_RUN = 60; // one lease's worth, under the router's 100/embed-batch cap
const MAX_EXTRACT_BYTES = 40 * 1024 * 1024;
const MIN_PDF_TEXT_CHARS = 16; // below this a PDF is treated as a scan → needs OCR (Phase 14)
const RESUME_DELAY_MS = 3_000;
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

/**
 * Cosine-nearest document chunks across the agent's ready documents.
 *
 * A relevance floor is applied (like recall's 0.75 and skills' 0.72): without
 * it, an unrelated question still returned the five nearest passages from the
 * owner's filed PDFs at any distance, which read as confident evidence and
 * invited the model to answer from irrelevant material. Callers scoped to a
 * single `documentId` (the model already knows which document) can lower it.
 */
export async function searchDocumentChunks(
  db: Db,
  input: {
    agentId: string;
    embedding: number[];
    limit: number;
    documentId?: string;
    minSimilarity?: number;
  },
): Promise<DocumentSearchHit[]> {
  const vec = JSON.stringify(input.embedding);
  const minSimilarity = input.minSimilarity ?? 0.7;
  const filters = [
    eq(documentChunks.agentId, input.agentId),
    eq(documents.status, 'ready'),
    sql`1 - (${documentChunks.embedding} <=> ${vec}::vector) >= ${minSimilarity}`,
  ];
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
