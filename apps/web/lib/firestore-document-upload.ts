import { createHash, randomUUID } from 'node:crypto';
import { extractorFor } from '@assistant/core/memory/document-types';
import type { DocumentCatalogRepository, Records } from '@assistant/persistence';

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

function cleanDocumentName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'document';
}

async function cleanupStagedObject(workspace: BinaryWorkspace, path: string): Promise<void> {
  await workspace.delete(path).catch((error) => {
    console.error(`Firestore document upload: staged object cleanup failed for ${path}`, error);
  });
}

/** Stage an owner text upload and atomically file its catalog/task/outbox records. */
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
