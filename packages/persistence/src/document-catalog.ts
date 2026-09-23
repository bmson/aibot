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
