import type { Records } from './records.js';

export type DocumentCatalogView = {
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
};

export type DocumentChunkView = { chunkIndex: number; text: string; charCount: number };

export type DocumentCatalogOverview = {
  documents: DocumentCatalogView[];
  stats: { total: number; ready: number; pending: number; chunks: number };
  primaryConversationId: string | null;
};

/** Read methods share the same owner-scoped DTO contract across persistence drivers. */
export interface DocumentCatalogReadRepository {
  readonly kind: 'document-catalog-read-repository';
  list(agentId: string): Promise<DocumentCatalogOverview>;
  get(
    agentId: string,
    documentId: string,
  ): Promise<{ document: DocumentCatalogView; chunks: DocumentChunkView[] } | null>;
}

/**
 * Durable record boundary for filing source bytes and a document before an
 * extractor is scheduled. Implementations must persist the file and document
 * together and report content-hash duplicates without creating a second file.
 * Blob storage and processor/task lifecycle belong to the caller.
 */
export interface DocumentCatalogRepository {
  readonly kind: 'document-catalog-repository';
  createDocumentCatalog(input: {
    file: Records['files'];
    document: Records['documents'];
  }): Promise<{
    document: Records['documents'];
    duplicate: boolean;
    task: { id: string; queueGeneration: number } | null;
  }>;
}

/** Lease fence required for every durable extraction lifecycle mutation. */
export type DocumentExtractionFence = {
  agentId: string;
  documentId: string;
  taskId: string;
  queueGeneration: number;
  leaseToken: string;
};

export type DocumentExtractionCursor = { index: number; total: number };

/**
 * Persistence boundary used by the document extractor. A chunk batch and its
 * task cursor must commit atomically; implementations must reject stale task
 * generations/leases, foreign owners, and active privacy erasures.
 */
export interface DocumentExtractionRepository {
  readonly kind: 'document-extraction-repository';
  load(fence: DocumentExtractionFence): Promise<{
    document: Records['documents'];
    file: Records['files'] | null;
  } | null>;
  begin(input: {
    fence: DocumentExtractionFence;
    extractor: string;
    cursor: DocumentExtractionCursor;
  }): Promise<boolean>;
  markPending(input: {
    fence: DocumentExtractionFence;
    status: 'pending' | 'unsupported';
    extractor: string;
  }): Promise<boolean>;
  persistBatch(input: {
    fence: DocumentExtractionFence;
    chunks: Records['documentChunks'][];
    cursor: DocumentExtractionCursor;
    state: unknown;
    progress: string;
    progressPercent: number;
  }): Promise<boolean>;
  finalize(input: {
    fence: DocumentExtractionFence;
    extractor: string;
    chunkCount: number;
    charCount: number;
    state: unknown;
  }): Promise<boolean>;
  fail(input: {
    fence: DocumentExtractionFence;
    error: string;
    keepStatus?: boolean;
  }): Promise<boolean>;
}

export interface DocumentSearchHit {
  documentId: string;
  title: string;
  source: string;
  trust: string;
  chunkIndex: number;
  text: string;
  similarity: number;
}

/** Nearest passages across the owner's ready documents (the `documents.search` tool). */
export interface DocumentSearchRepository {
  readonly kind: 'document-search-repository';
  search(input: {
    agentId: string;
    embedding: number[];
    limit: number;
    documentId?: string;
    minSimilarity: number;
  }): Promise<DocumentSearchHit[]>;
}

export interface ProcessableDocument {
  id: string;
  agentId: string;
  title: string;
  mime: string;
  extractor: string;
  workspacePath: string;
}

export type DocumentProcessorRecordOutcome =
  | { ok: true; documentId: string; agentId: string; extract: boolean }
  | { ok: false; status: 404 | 409 | 403; error: string };

/**
 * The heavy-format processor lifecycle (`documents.process` and its one-shot
 * callback). Launches are atomic claims keyed on a callback-token hash, so two
 * overlapping sweeps never launch one document twice and a replayed callback
 * is refused.
 */
export interface DocumentProcessorRepository {
  readonly kind: 'document-processor-repository';
  /** Fail pending processor documents that used up their launches; returns how many. */
  retireExhausted(maxAttempts: number, now: Date): Promise<number>;
  /** Pending processor documents whose run is missing or started before `staleBefore`. */
  claimable(input: {
    documentId?: string;
    staleBefore: Date;
    limit: number;
  }): Promise<ProcessableDocument[]>;
  /** Claim one for a launch; false when another sweep claimed it first. */
  claim(id: string, input: { tokenHash: string; now: Date; staleBefore: Date }): Promise<boolean>;
  /** Release a claim after a definite launch failure, so the next sweep retries. */
  release(id: string, now: Date): Promise<void>;
  /**
   * Verify the callback token and record the worker's outcome, clearing the
   * token. On success the document points at `processedTextPath` and needs
   * its extraction task.
   */
  recordResult(input: {
    documentId: string;
    tokenMatches: (storedHash: string) => boolean;
    ok: boolean;
    unsupported: boolean;
    error: string;
    processedTextPath: string;
    now: Date;
  }): Promise<DocumentProcessorRecordOutcome>;
}
