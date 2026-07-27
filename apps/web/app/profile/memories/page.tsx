import {
  listMemoryLibrary,
  type MemoryFilter,
  type MemorySnapshot,
  type MemoryState,
} from '@assistant/application/profile';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import Link from 'next/link';
import { FactRow, type FactView } from '@/app/profile/fact-row';
import { requireOwner } from '@/auth';
import { relativeTime } from '@/lib/format';
import { getDb } from '@/lib/server';
import {
  BackLink,
  btn,
  inputClass,
  PageHeader,
  PageShell,
  segmentedControlClass,
  segmentedItemClass,
} from '@/lib/ui';

export const metadata = { title: 'Memory library' };
export const dynamic = 'force-dynamic';

// Two axes the owner actually cares about, instead of four overlapping buckets:
// the top-level STATE (is a fact in use, or held back for review?) and, within
// the in-use set, an optional FILTER (verified wording, or not yet tidied).
const STATES = ['in-use', 'review'] as const;
const FILTERS = ['all', 'verified', 'untidied'] as const;

const stateCopy: Record<MemoryState, { label: string; title: string; intro: string }> = {
  'in-use': {
    label: 'In use',
    title: 'In use by the assistant',
    intro: 'Active saved facts the assistant can recall when they are relevant.',
  },
  review: {
    label: 'Held for review',
    title: 'Held for your review',
    intro: 'These came from an unverified source and stay unavailable until you approve them.',
  },
};

const filterCopy: Record<MemoryFilter, { label: string; intro: string }> = {
  all: { label: 'All', intro: '' },
  verified: {
    label: 'Verified',
    intro: 'You confirmed or corrected these, so organization protects their wording.',
  },
  untidied: {
    label: 'Not yet tidied',
    intro: 'Not yet checked for repetition, direct conflicts, or topic cleanup.',
  },
};

function toFactView(
  memory: MemorySnapshot,
  now: Date,
  subjectLabel: string | null,
  aboutOwner: boolean,
): FactView {
  const from = memory.validFrom?.toISOString().slice(0, 10);
  const until = memory.validUntil?.toISOString().slice(0, 10);
  return {
    id: memory.id,
    content: memory.content,
    kind: memory.kind,
    domain: memory.domain ?? '',
    confidence: Number(memory.confidence),
    importance: memory.importance,
    ownerConfirmed: memory.ownerConfirmed,
    pinned: memory.pinned,
    organized: memory.lastConsolidatedAt !== null,
    inCard: false,
    aboutOwner,
    originTrust: memory.originTrust,
    sourceTaskId: memory.sourceTaskId,
    subjectLabel,
    createdLabel: relativeTime(memory.createdAt, now),
    validityLabel: from ? `${from}–${until ?? 'now'}` : '',
  };
}

function hrefFor(opts: {
  state?: MemoryState;
  filter?: MemoryFilter;
  q?: string;
  page?: number;
}): string {
  const params = new URLSearchParams();
  const state = opts.state ?? 'in-use';
  if (state !== 'in-use') params.set('state', state);
  if (state === 'in-use' && opts.filter && opts.filter !== 'all') params.set('filter', opts.filter);
  if (opts.q) params.set('q', opts.q);
  if (opts.page && opts.page > 1) params.set('page', String(opts.page));
  const qs = params.toString();
  return qs ? `/profile/memories?${qs}` : '/profile/memories';
}

export default async function MemoryLibraryPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string; filter?: string; q?: string; page?: string }>;
}) {
  await requireOwner();
  const params = await searchParams;
  const state: MemoryState = STATES.includes(params.state as MemoryState)
    ? (params.state as MemoryState)
    : 'in-use';
  const filter: MemoryFilter =
    state === 'in-use' && FILTERS.includes(params.filter as MemoryFilter)
      ? (params.filter as MemoryFilter)
      : 'all';
  const query = (params.q ?? '').trim().slice(0, 120);
  const requestedPage = Number.parseInt(params.page ?? '1', 10);
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const db = getDb();
  const now = new Date();
  const {
    rows,
    total,
    page: safePage,
    totalPages,
  } = await listMemoryLibrary(db, {
    state,
    filter,
    query,
    page,
  });

  const intro =
    state === 'in-use' && filter !== 'all' ? filterCopy[filter].intro : stateCopy[state].intro;

  return (
    <PageShell size="reading">
      <BackLink href="/profile">Memory overview</BackLink>
      <PageHeader title={stateCopy[state].title} intro={intro} />

      <div className="mt-6 grid min-w-0 gap-3 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center">
        <nav className={segmentedControlClass} aria-label="Memory state">
          {STATES.map((item) => (
            <Link
              key={item}
              href={hrefFor({ state: item, q: query })}
              aria-current={item === state ? 'page' : undefined}
              className={`${segmentedItemClass} ${
                item === state ? 'bg-raised text-strong shadow-sm' : ''
              }`}
            >
              {stateCopy[item].label}
            </Link>
          ))}
        </nav>
        <form action="/profile/memories" method="get" className="flex min-w-0 gap-2">
          <input type="hidden" name="state" value={state} />
          {state === 'in-use' && filter !== 'all' ? (
            <input type="hidden" name="filter" value={filter} />
          ) : null}
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">Search memories</span>
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
              aria-hidden="true"
            />
            <input
              type="search"
              name="q"
              defaultValue={query}
              placeholder="Search what the assistant remembers"
              className={`${inputClass} w-full pl-9`}
            />
          </label>
          <button type="submit" className={btn.outline}>
            Search
          </button>
        </form>
      </div>

      {state === 'in-use' ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-2xs font-medium text-muted">Show</span>
          {FILTERS.map((item) => (
            <Link
              key={item}
              href={hrefFor({ state: 'in-use', filter: item, q: query })}
              aria-current={item === filter ? 'true' : undefined}
              className={`rounded-full px-2.5 py-1 text-xs font-medium motion-safe:transition-colors ${
                item === filter
                  ? 'bg-accent/10 text-accent ring-1 ring-accent/30'
                  : 'bg-sunken/60 text-muted hover:text-strong'
              }`}
            >
              {filterCopy[item].label}
            </Link>
          ))}
        </div>
      ) : null}

      <div className="mt-6 flex items-baseline justify-between gap-3 border-b border-edge pb-3">
        <p className="text-[13px] font-medium">
          {total.toLocaleString()} memor{total === 1 ? 'y' : 'ies'}
          {query ? ` matching “${query}”` : ''}
        </p>
        {totalPages > 1 ? (
          <p className="text-xs text-muted">
            Page {safePage} of {totalPages}
          </p>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <div className="py-16 text-center">
          <p className="text-[15px] font-medium">Nothing here right now</p>
          <p className="mt-1 text-[13px] text-muted">
            {query ? 'Try a broader search.' : 'This memory view is clear.'}
          </p>
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          {rows.map(({ memory, subjectLabel, subjectTrust }) => (
            <FactRow
              key={memory.id}
              fact={toFactView(memory, now, subjectLabel, subjectTrust === 'owner')}
              quarantine={state === 'review'}
            />
          ))}
        </div>
      )}

      {totalPages > 1 ? (
        <nav className="mt-6 flex items-center justify-between gap-3" aria-label="Memory pages">
          {safePage > 1 ? (
            <Link
              href={hrefFor({ state, filter, q: query, page: safePage - 1 })}
              className={btn.outline}
            >
              <ChevronLeft className="size-4" aria-hidden="true" />
              Previous
            </Link>
          ) : (
            <span />
          )}
          {safePage < totalPages ? (
            <Link
              href={hrefFor({ state, filter, q: query, page: safePage + 1 })}
              className={btn.outline}
            >
              Next
              <ChevronRight className="size-4" aria-hidden="true" />
            </Link>
          ) : null}
        </nav>
      ) : null}
    </PageShell>
  );
}
