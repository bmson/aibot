import { randomUUID } from 'node:crypto';
import { getAgent } from '@assistant/core/chat';
import {
  deleteImportSource,
  purgeImportSource,
  reviewImportSource,
  startImport,
} from '@assistant/core/memory/import';
import { detectKind } from '@assistant/core/memory/import-parsers';
import {
  isVoiceImportSource,
  isVoiceRegister,
  registerForFilename,
  startVoiceIngest,
} from '@assistant/core/memory/voice-ingest';
import { type Db, importSources, memories } from '@assistant/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import { safeWorkspacePath, type WorkspacePort } from './workspace.js';

export type ImportSourceSnapshot = typeof importSources.$inferSelect;

export interface ImportOverview {
  sources: ImportSourceSnapshot[];
  quarantineBySource: Record<string, number>;
  unstartedFiles: Array<{ name: string; dir: boolean }>;
}

export async function getImportOverview(db: Db, workspace: WorkspacePort): Promise<ImportOverview> {
  const [allSources, quarantineCounts, importFiles] = await Promise.all([
    db.select().from(importSources).orderBy(desc(importSources.updatedAt)),
    db
      .select({ source: memories.source, count: sql<number>`count(*)` })
      .from(memories)
      .where(and(eq(memories.quarantined, true), sql`${memories.source} IS NOT NULL`))
      .groupBy(memories.source),
    workspace.list('import').catch(() => [] as Array<{ name: string; dir: boolean }>),
  ]);
  const sources = allSources.filter((source) => !isVoiceImportSource(source.source));
  const quarantineBySource = Object.fromEntries(
    quarantineCounts.map((row) => [row.source ?? '', Number(row.count)]),
  );
  const knownPaths = new Set(allSources.map((source) => source.workspacePath));
  const unstartedFiles = importFiles.filter(
    (file) => !file.dir && !knownPaths.has(`import/${file.name}`),
  );
  return { sources, quarantineBySource, unstartedFiles };
}

export async function startWorkspaceImport(
  db: Db,
  workspace: WorkspacePort,
  workspacePath: string,
  source: string,
): Promise<{ error?: string }> {
  try {
    const agent = await getAgent(db);
    const content = await workspace.read(workspacePath);
    await startImport(db, {
      agentId: agent.id,
      source,
      workspacePath,
      kind: detectKind(workspacePath, content.slice(0, 4000)),
    });
    return {};
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function purgeImportedSource(db: Db, source: string): Promise<{ purged: number }> {
  return purgeImportSource(db, source);
}

export function deleteImportedSource(
  db: Db,
  workspace: WorkspacePort,
  source: string,
): Promise<{ purgedMemories: number }> {
  return deleteImportSource(db, source, workspace);
}

export function reviewImportedSource(
  db: Db,
  source: string,
  verdict: 'approve' | 'reject',
): Promise<{ reviewed: number }> {
  return reviewImportSource(db, source, verdict);
}

function cleanImportName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'archive.txt';
}

export async function uploadImport(
  db: Db,
  workspace: WorkspacePort,
  input: {
    fileName: string;
    content: string;
    source?: string;
    voice?: boolean;
    register?: string;
  },
): Promise<{ destination: '/profile' | '/import' }> {
  const agent = await getAgent(db);
  const cleanName = cleanImportName(input.fileName);
  const workspacePath = safeWorkspacePath(`import/uploads/${randomUUID()}-${cleanName}`);
  const source = input.source?.trim() || cleanName.replace(/\.[a-z0-9]+$/i, '').toLowerCase();
  const kind = detectKind(cleanName, input.content.slice(0, 4000));
  await workspace.write(workspacePath, input.content);
  try {
    if (input.voice) {
      const requestedRegister = input.register ?? '';
      const register = isVoiceRegister(requestedRegister)
        ? requestedRegister
        : registerForFilename(input.fileName);
      await startVoiceIngest(db, {
        agentId: agent.id,
        source: input.source?.trim() || cleanName,
        workspacePath,
        kind,
        register,
      });
      return { destination: '/profile' };
    }
    await startImport(db, { agentId: agent.id, source, workspacePath, kind });
    return { destination: '/import' };
  } catch (error) {
    await workspace.delete(workspacePath).catch(() => {});
    throw error;
  }
}
