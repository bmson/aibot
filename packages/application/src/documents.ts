import { createHash, randomUUID } from 'node:crypto';
import { getAgent, getOrCreatePrimaryConversation } from '@assistant/core/chat';
import {
  documentStats,
  listDocuments,
  purgeDocument,
  startDocumentIngest,
} from '@assistant/core/memory/document-catalog';
import { type Db, files } from '@assistant/db';
import { and, eq } from 'drizzle-orm';
import { safeWorkspacePath, type WorkspacePort } from './workspace.js';

const SAFE_DOWNLOAD_PREFIXES = ['code/', 'browser/attachments/', 'documents/'];

function cleanDocumentName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'document';
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
