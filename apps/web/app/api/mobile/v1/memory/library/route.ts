import {
  listMemoryLibrary,
  listMemoryLibraryFilters,
  type MemoryFilter,
  type MemoryState,
} from '@assistant/application/profile';
import { getDb } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const STATES: MemoryState[] = ['in-use', 'review'];
const FILTERS: MemoryFilter[] = ['all', 'verified', 'untidied'];
const CONNECTIVITY = ['all', 'connected', 'unconnected'] as const;

function pick<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/**
 * The memory library, paged and filtered.
 *
 * The workspace payload carries the first 80 owner facts for the Memory
 * screen's summary, which meant the phone could not reach the 81st fact at
 * all — not a filtering gap so much as a cap on seeing your own memory. This
 * serves the same query the web library runs, so both clients page and filter
 * the same way.
 */
export async function GET(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const params = new URL(request.url).searchParams;
  const ageDays = Number(params.get('ageDays'));

  const [library, filters] = await Promise.all([
    listMemoryLibrary(getDb(), {
      state: pick(params.get('state'), STATES, 'in-use'),
      filter: pick(params.get('filter'), FILTERS, 'all'),
      query: params.get('q')?.slice(0, 200) ?? '',
      page: Math.max(1, Number(params.get('page')) || 1),
      subjectId: params.get('subjectId') || undefined,
      domain: params.get('domain') || undefined,
      source: params.get('source') || undefined,
      ageDays: Number.isFinite(ageDays) && ageDays > 0 ? ageDays : undefined,
      connectivity: pick(params.get('connectivity'), CONNECTIVITY, 'all'),
    }),
    listMemoryLibraryFilters(getDb()),
  ]);

  return mobileJson({
    rows: library.rows.map((row) => ({
      id: row.memory.id,
      content: row.memory.content,
      domain: row.memory.domain ?? '',
      ownerConfirmed: row.memory.ownerConfirmed,
      pinned: row.memory.pinned,
      importance: row.memory.importance,
      // The state parameter already decides quarantined-or-not, so the row
      // carries the two things the list actually distinguishes on.
      organized: row.memory.lastConsolidatedAt !== null,
      originTrust: row.memory.originTrust,
      subjectLabel: row.subjectLabel ?? '',
      connectionCount: row.connectionCount,
      projectionStatus: row.projectionStatus,
      createdAt: row.memory.createdAt.toISOString(),
    })),
    total: library.total,
    page: library.page,
    totalPages: library.totalPages,
    subjects: filters.subjects,
    sources: filters.sources,
  });
}
