import type { Records } from './records.js';

export type ProfileMemoryState = 'in-use' | 'review';
export type ProfileMemoryFilter = 'all' | 'verified' | 'untidied';

export interface ProfileLibraryInput {
  state: ProfileMemoryState;
  filter: ProfileMemoryFilter;
  query: string;
  page: number;
  pageSize: number;
  subjectId?: string;
  domain?: string;
  source?: string;
  ageDays?: number;
  connectivity?: 'all' | 'connected' | 'unconnected';
  now: Date;
  extractionVersion: number;
}

export interface ProfileLibraryRecord {
  memory: Records['memories'];
  subject: Pick<Records['contacts'], 'id' | 'name' | 'trust'> | null;
  connectionCount: number;
  source: Pick<
    Records['knowledgeGraphSources'],
    'status' | 'contentHash' | 'extractionVersion'
  > | null;
}

export interface ProfileLibraryRepository {
  readonly kind: 'profile-library-repository';
  listFilters(agentId: string): Promise<{
    subjects: Array<{ id: string; label: string; trust: string }>;
    sources: string[];
  }>;
  list(
    agentId: string,
    input: ProfileLibraryInput,
  ): Promise<{ rows: ProfileLibraryRecord[]; total: number; page: number; totalPages: number }>;
}
