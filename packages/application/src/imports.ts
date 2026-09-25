import { randomUUID } from 'node:crypto';
import { getAgent } from '@assistant/core/chat';
import { compileOwnerCard } from '@assistant/core/memory/consolidation';
import {
  deleteImportSource,
  purgeImportSource,
  reviewImportSource,
  startImport,
  startPortableImport,
} from '@assistant/core/memory/import';
import { detectKind } from '@assistant/core/memory/import-parsers';
import {
  isVoiceImportSource,
  isVoiceRegister,
  registerForFilename,
  startPortableVoiceIngest,
  startVoiceIngest,
} from '@assistant/core/memory/voice-ingest';
import { type Db, importSources, memories } from '@assistant/db';
import {
  type ImportCommandRepository,
  type ImportOverviewRepository,
  isImportOverviewRepository,
  type OwnerCardCompilationRepository,
  type Records,
} from '@assistant/persistence';
import { and, desc, eq, sql } from 'drizzle-orm';
import { safeWorkspacePath, type WorkspacePort } from './workspace.js';

export type ImportSourceSnapshot = Records['importSources'];

/** Portable import commands: the source commands plus the owner card they invalidate. */
export interface ImportCommandPersistence {
  readonly kind: 'import-command-persistence';
  imports: ImportCommandRepository;
  ownerCards: OwnerCardCompilationRepository;
}

function isImportCommandPersistence(value: unknown): value is ImportCommandPersistence {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'import-command-persistence'
  );
}

async function recompileOwnerCard(persistence: ImportCommandPersistence, agentId: string) {
  await compileOwnerCard(persistence.ownerCards, agentId).catch((err) =>
    console.error('card recompile failed', err),
  );
}

export interface ImportOverview {
  sources: ImportSourceSnapshot[];
  quarantineBySource: Record<string, number>;
  unstartedFiles: Array<{ name: string; dir: boolean }>;
}

export function getImportOverview(db: Db, workspace: WorkspacePort): Promise<ImportOverview>;
export function getImportOverview(
  repository: ImportOverviewRepository,
  workspace: WorkspacePort,
): Promise<ImportOverview>;
export async function getImportOverview(
  source: Db | ImportOverviewRepository,
  workspace: WorkspacePort,
): Promise<ImportOverview> {
  if (isImportOverviewRepository(source)) {
    const [data, importFiles] = await Promise.all([
      source.load(),
      workspace.list('import').catch(() => [] as Array<{ name: string; dir: boolean }>),
    ]);
    return importOverviewFrom(data.sources, data.quarantineBySource, importFiles);
  }

  const db = source as Db;
  const [allSources, quarantineCounts, importFiles] = await Promise.all([
    db.select().from(importSources).orderBy(desc(importSources.updatedAt)),
    db
      .select({ source: memories.source, count: sql<number>`count(*)` })
      .from(memories)
      .where(and(eq(memories.quarantined, true), sql`${memories.source} IS NOT NULL`))
      .groupBy(memories.source),
    workspace.list('import').catch(() => [] as Array<{ name: string; dir: boolean }>),
  ]);
  const quarantineBySource = Object.fromEntries(
    quarantineCounts.map((row) => [row.source ?? '', Number(row.count)]),
  );
  return importOverviewFrom(allSources, quarantineBySource, importFiles);
}

function importOverviewFrom(
  allSources: ImportSourceSnapshot[],
  quarantineBySource: Record<string, number>,
  importFiles: Array<{ name: string; dir: boolean }>,
): ImportOverview {
  const sources = allSources.filter((source) => !isVoiceImportSource(source.source));
  const knownPaths = new Set(allSources.map((source) => source.workspacePath));
  const unstartedFiles = importFiles.filter(
    (file) => !file.dir && !knownPaths.has(`import/${file.name}`),
  );
  return { sources, quarantineBySource, unstartedFiles };
}

export async function startWorkspaceImport(
  store: Db | ImportCommandPersistence,
  workspace: WorkspacePort,
  workspacePath: string,
  source: string,
): Promise<{ error?: string }> {
  try {
    const content = await workspace.read(workspacePath);
    const kind = detectKind(workspacePath, content.slice(0, 4000));
    if (isImportCommandPersistence(store)) {
      await startPortableImport(store.imports, { source, workspacePath, kind });
      return {};
    }
    const agent = await getAgent(store);
    await startImport(store, { agentId: agent.id, source, workspacePath, kind });
    return {};
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export async function purgeImportedSource(
  store: Db | ImportCommandPersistence,
  source: string,
): Promise<{ purged: number }> {
  if (!isImportCommandPersistence(store)) return purgeImportSource(store, source);
  const result = await store.imports.purge(source);
  await recompileOwnerCard(store, result.agentId);
  return { purged: result.purged };
}

export async function deleteImportedSource(
  store: Db | ImportCommandPersistence,
  workspace: WorkspacePort,
  source: string,
): Promise<{ purgedMemories: number }> {
  if (!isImportCommandPersistence(store)) return deleteImportSource(store, source, workspace);
  const result = await store.imports.remove(source);
  await workspace.delete(result.workspacePath).catch((err) => {
    console.error(`workspace delete failed for ${result.workspacePath}`, err);
  });
  await recompileOwnerCard(store, result.agentId);
  return { purgedMemories: result.purgedMemories };
}

export async function reviewImportedSource(
  store: Db | ImportCommandPersistence,
  source: string,
  verdict: 'approve' | 'reject',
): Promise<{ reviewed: number }> {
  if (!isImportCommandPersistence(store)) return reviewImportSource(store, source, verdict);
  const result = await store.imports.review(source, verdict);
  if (result.reviewed > 0) await recompileOwnerCard(store, result.agentId);
  return { reviewed: result.reviewed };
}

type VoiceStart = Omit<Parameters<typeof startVoiceIngest>[1], 'agentId'>;
type BackstoryStart = Omit<Parameters<typeof startImport>[1], 'agentId'>;

function portableImportStarters(imports: ImportCommandRepository) {
  return {
    voice: async (input: VoiceStart) => {
      await startPortableVoiceIngest(imports, input);
    },
    backstory: async (input: BackstoryStart) => {
      await startPortableImport(imports, input);
    },
  };
}

async function postgresImportStarters(db: Db) {
  const agent = await getAgent(db);
  return {
    voice: async (input: VoiceStart) => {
      await startVoiceIngest(db, { ...input, agentId: agent.id });
    },
    backstory: async (input: BackstoryStart) => {
      await startImport(db, { ...input, agentId: agent.id });
    },
  };
}

function cleanImportName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'archive.txt';
}

export async function uploadImport(
  store: Db | ImportCommandPersistence,
  workspace: WorkspacePort,
  input: {
    fileName: string;
    content: string;
    source?: string;
    voice?: boolean;
    register?: string;
  },
): Promise<{ destination: '/profile/voice' | '/import' }> {
  const start = isImportCommandPersistence(store)
    ? portableImportStarters(store.imports)
    : await postgresImportStarters(store);
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
      await start.voice({
        source: input.source?.trim() || cleanName,
        workspacePath,
        kind,
        register,
      });
      return { destination: '/profile/voice' };
    }
    await start.backstory({ source, workspacePath, kind });
    return { destination: '/import' };
  } catch (error) {
    await workspace.delete(workspacePath).catch(() => {});
    throw error;
  }
}
