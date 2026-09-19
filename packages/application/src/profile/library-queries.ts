import { GRAPH_EXTRACTION_VERSION } from '@assistant/core/memory/knowledge-graph';
import type {
  ProfileLibraryRecord,
  ProfileLibraryRepository,
  ProfileMemoryFilter,
  ProfileMemoryState,
} from '@assistant/persistence';

export type MemoryState = ProfileMemoryState;
export type MemoryFilter = ProfileMemoryFilter;
export type MemoryProjectionStatus = 'connected' | 'mapping' | 'needs_attention' | 'no_connections';

export interface MemoryLibraryInput {
  state: MemoryState;
  filter: MemoryFilter;
  query: string;
  page: number;
  pageSize?: number;
  subjectId?: string;
  domain?: string;
  source?: string;
  ageDays?: number;
  connectivity?: 'all' | 'connected' | 'unconnected';
}

export interface MemoryLibraryFilters {
  subjects: Array<{ id: string; label: string; trust: string }>;
  sources: string[];
}

export type PortableMemoryLibrary = Awaited<
  ReturnType<ReturnType<typeof profileLibraryQueries>['list']>
>;

function projectionStatusOf(row: ProfileLibraryRecord): MemoryProjectionStatus {
  if (row.connectionCount > 0) return 'connected';
  if (row.source?.status === 'failed' || row.source?.status === 'quarantined') {
    return 'needs_attention';
  }
  if (
    !row.source ||
    row.source.status === 'pending' ||
    row.source.contentHash !== row.memory.contentHash ||
    row.source.extractionVersion < GRAPH_EXTRACTION_VERSION
  ) {
    return 'mapping';
  }
  return 'no_connections';
}

/** SQL-free application composition for the profile memory library. */
export function profileLibraryQueries(repository: ProfileLibraryRepository, agentId: string) {
  return {
    listFilters: (): Promise<MemoryLibraryFilters> => repository.listFilters(agentId),
    async list(input: MemoryLibraryInput) {
      const result = await repository.list(agentId, {
        ...input,
        pageSize: input.pageSize ?? 60,
        now: new Date(),
        extractionVersion: GRAPH_EXTRACTION_VERSION,
      });
      return {
        ...result,
        rows: result.rows.map((row) => ({
          memory: row.memory,
          subjectId: row.subject?.id ?? null,
          subjectLabel: row.subject?.name ?? null,
          subjectTrust: row.subject?.trust ?? null,
          connectionCount: row.connectionCount,
          projectionStatus: projectionStatusOf(row),
        })),
      };
    },
  };
}
