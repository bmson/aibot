import { createHash, randomUUID } from 'node:crypto';
import { getAgent, getOrCreatePrimaryConversation } from '@assistant/core/chat';
import {
  documentStats,
  listDocuments,
  purgeDocument,
  startDocumentIngest,
} from '@assistant/core/memory/document-catalog';
import { extractorFor } from '@assistant/core/memory/document-types';
import { type Db, documentChunks, documents, files } from '@assistant/db';
import type { DocumentCatalogRepository, Records } from '@assistant/persistence';
import { and, asc, eq } from 'drizzle-orm';
import { safeWorkspacePath, type WorkspacePort } from './workspace.js';

const SAFE_DOWNLOAD_PREFIXES = ['code/', 'browser/attachments/', 'documents/'];

function cleanDocumentName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'document';
}

interface BinaryWorkspace {
  writeBytes(relativePath: string, content: Buffer, contentType: string): Promise<unknown>;
  delete(relativePath: string): Promise<void>;
}

const TEXT_MIMES = new Set([
  'application/json',
  'application/xml',
  'application/xhtml+xml',
  'application/csv',
  'application/x-ndjson',
  'application/x-yaml',
  'application/yaml',
  'application/markdown',
]);

export function isSupportedFirestoreTextDocument(mime: string, name: string): boolean {
  const baseMime = (mime || 'application/octet-stream').split(';')[0]?.trim().toLowerCase() ?? '';
  const mimeAllowsText =
    baseMime.startsWith('text/') ||
    TEXT_MIMES.has(baseMime) ||
    baseMime === 'application/octet-stream';
  return mimeAllowsText && extractorFor(baseMime, name) === 'text';
}

async function cleanupStagedObject(workspace: BinaryWorkspace, path: string): Promise<void> {
  await workspace.delete(path).catch((error) => {
    console.error(`Firestore document upload: staged object cleanup failed for ${path}`, error);
  });
}

/** Stage an owner text upload and atomically file its Firestore catalog/task/outbox records. */
export async function uploadFirestoreTextDocument(input: {
  catalog: DocumentCatalogRepository;
  workspace: BinaryWorkspace;
  agentId: string;
  name: string;
  title?: string;
  mime?: string;
  bytes: Buffer;
}): Promise<{ duplicate: boolean }> {
  const name = cleanDocumentName(input.name);
  const mime = input.mime || 'application/octet-stream';
  if (!isSupportedFirestoreTextDocument(mime, name))
    throw new Error('Firestore uploads currently support text documents only');

  const fileId = randomUUID();
  const documentId = randomUUID();
  const workspacePath = `documents/uploads/${fileId}-${name}`;
  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  try {
    await input.workspace.writeBytes(workspacePath, input.bytes, mime);
    const now = new Date();
    const file: Records['files'] = {
      id: fileId,
      createdAt: now,
      agentId: input.agentId,
      taskId: null,
      workspacePath,
      mime,
      bytes: input.bytes.length,
      sha256,
    };
    const document: Records['documents'] = {
      id: documentId,
      createdAt: now,
      updatedAt: now,
      agentId: input.agentId,
      fileId,
      title: (input.title?.trim() || name).slice(0, 300),
      mime,
      source: 'upload',
      sourceRef: '',
      trust: 'owner',
      sha256,
      status: 'pending',
      extractor: 'text',
      chunkCount: 0,
      charCount: 0,
      error: null,
      processorTokenHash: null,
      processorStartedAt: null,
      processorAttempts: 0,
      processedTextPath: null,
    };
    const result = await input.catalog.createDocumentCatalog({ file, document });
    if (result.duplicate) await cleanupStagedObject(input.workspace, workspacePath);
    return { duplicate: result.duplicate };
  } catch (error) {
    await cleanupStagedObject(input.workspace, workspacePath);
    throw error;
  }
}

export async function getDocumentsOverview(db: Db) {
  const agent = await getAgent(db);
  const [documents, stats, primary] = await Promise.all([
    listDocuments(db, agent.id),
    documentStats(db, agent.id),
    getOrCreatePrimaryConversation(db, agent.id),
  ]);
  return { documents, stats, primaryConversationId: primary.id };
}

export async function getDocument(db: Db, documentId: string) {
  const agent = await getAgent(db);
  const [row] = await db
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
      fileId: documents.fileId,
    })
    .from(documents)
    .innerJoin(files, eq(files.id, documents.fileId))
    .where(
      and(
        eq(documents.agentId, agent.id),
        eq(documents.id, documentId),
        eq(files.agentId, agent.id),
      ),
    )
    .limit(1);
  if (!row) return null;
  const chunks = await db
    .select({
      chunkIndex: documentChunks.chunkIndex,
      text: documentChunks.text,
      charCount: documentChunks.charCount,
    })
    .from(documentChunks)
    .where(and(eq(documentChunks.agentId, agent.id), eq(documentChunks.documentId, documentId)))
    .orderBy(asc(documentChunks.chunkIndex));
  const { fileId: _fileId, ...document } = { ...row, bytes: row.bytes ?? 0 };
  return { document, chunks };
}

export async function deleteDocument(
  db: Db,
  workspace: WorkspacePort,
  documentId: string,
): Promise<void> {
  const agent = await getAgent(db);
  await purgeDocument(db, agent.id, documentId, workspace);
}

export async function uploadDocument(
  db: Db,
  workspace: WorkspacePort,
  input: { name: string; title?: string; mime?: string; bytes: Buffer },
): Promise<{ duplicate: boolean }> {
  const agent = await getAgent(db);
  const name = cleanDocumentName(input.name);
  const mime = input.mime || 'application/octet-stream';
  const workspacePath = safeWorkspacePath(`documents/uploads/${randomUUID()}-${name}`);
  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  await workspace.writeBytes(workspacePath, input.bytes, mime);
  try {
    const result = await startDocumentIngest(db, {
      agentId: agent.id,
      title: input.title?.trim() || name,
      workspacePath,
      mime,
      bytes: input.bytes.length,
      sha256,
      source: 'upload',
      trust: 'owner',
    });
    if (result.duplicate) await workspace.delete(workspacePath).catch(() => {});
    return { duplicate: result.duplicate };
  } catch (error) {
    await workspace.delete(workspacePath).catch(() => {});
    throw error;
  }
}

export interface DownloadedArtifact {
  bytes: Buffer;
  contentType: string;
  filename: string;
}

export async function downloadArtifact(
  db: Db,
  workspace: WorkspacePort,
  workspacePath: string,
): Promise<DownloadedArtifact | null> {
  if (!SAFE_DOWNLOAD_PREFIXES.some((prefix) => workspacePath.startsWith(prefix))) return null;
  const agent = await getAgent(db);
  const [row] = await db
    .select({ mime: files.mime })
    .from(files)
    .where(and(eq(files.agentId, agent.id), eq(files.workspacePath, workspacePath)))
    .limit(1);
  if (!row) return null;
  const bytes = await workspace.readBytes(workspacePath).catch(() => null);
  if (!bytes) return null;
  return {
    bytes,
    contentType: row.mime || 'application/octet-stream',
    filename: (workspacePath.split('/').pop() ?? 'file').replace(/[\r\n"]/g, '_'),
  };
}
