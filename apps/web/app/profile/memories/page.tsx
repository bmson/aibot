import { getAgent } from '@assistant/core';
import { contacts, type MemoryRow, memories } from '@assistant/db';
import { and, count, desc, eq, gt, ilike, isNull, or, type SQL, sql } from 'drizzle-orm';
import { ArrowLeft, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import Link from 'next/link';
import { FactRow, type FactView } from '@/app/profile/fact-row';
import { requireOwner } from '@/auth';
import { relativeTime } from '@/lib/format';
import { getDb } from '@/lib/server';
import {
  btn,
  inputClass,
  PageHeader,
  PageShell,
  segmentedControlClass,
  segmentedItemClass,
} from '@/lib/ui';

export const metadata = { title: 'Memory library' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 60;
const VIEWS = ['available', 'waiting', 'review', 'verified'] as const;
type MemoryView = (typeof VIEWS)[number];

const viewCopy: Record<MemoryView, { label: string; title: string; intro: string }> = {
  available: {
    label: 'Available',
    title: 'Available to AI Bot',
    intro: 'Active saved facts that AI Bot can recall when they are relevant.',
  },
  waiting: {
    label: 'Waiting for a pass',
    title: 'Waiting for a cleanup pass',
    intro: 'These have not yet been checked for repetition, direct conflicts, or topic cleanup.',
  },
  review: {
    label: 'Needs review',
    title: 'Needs your review',
    intro: 'These came from an unverified source and stay unavailable until you approve them.',
  },
  verified: {
    label: 'Verified by you',
    title: 'Verified by you',
    intro: 'You confirmed or corrected these facts, so organization protects their wording.',
  },
};

function toFactView(memory: MemoryRow, now: Date, subjectLabel: string | null): FactView {
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
    originTrust: memory.originTrust,
    sourceTaskId: memory.sourceTaskId,
    subjectLabel,
    createdLabel: relativeTime(memory.createdAt, now),
    validityLabel: from ? `${from}–${until ?? 'now'}` : '',
  };
}

function hrefFor(view: MemoryView, query: string, page = 1): string {
  const params = new URLSearchParams({ view });
  if (query) params.set('q', query);
  if (page > 1) params.set('page', String(page));
  return `/profile/memories?${params.toString()}`;
}

export default async function MemoryLibraryPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; q?: string; page?: string }>;
}) {
  await requireOwner();
  const params = await searchParams;
  const view = VIEWS.includes(params.view as MemoryView)
    ? (params.view as MemoryView)
    : 'available';
  const query = (params.q ?? '').trim().slice(0, 120);
  const requestedPage = Number.parseInt(params.page ?? '1', 10);
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const db = getDb();
  const agent = await getAgent(db);
  const now = new Date();

  const unexpired = or(isNull(memories.expiresAt), gt(memories.expiresAt, sql`now()`));
  const stateCondition: SQL | undefined =
    view === 'review'
      ? eq(memories.quarantined, true)
      : view === 'waiting'
        ? and(eq(memories.quarantined, false), isNull(memories.lastConsolidatedAt))
        : view === 'verified'
          ? and(eq(memories.quarantined, false), eq(memories.ownerConfirmed, true))
          : eq(memories.quarantined, false);
  const filters = and(
    eq(memories.agentId, agent.id),
    eq(memories.category, 'knowledge'),
    unexpired,
    stateCondition,
    query
      ? ilike(memories.content, `%${query.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`)
      : undefined,
  );

  const [totalRow] = await db.select({ value: count() }).from(memories).where(filters);
  const total = Number(totalRow?.value ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const rows = await db
    .select({ memory: memories, subjectLabel: contacts.name })
    .from(memories)
    .leftJoin(contacts, eq(memories.subjectContactId, contacts.id))
    .where(filters)
    .orderBy(
      desc(memories.pinned),
      desc(memories.ownerConfirmed),
      desc(memories.importance),
      desc(memories.createdAt),
    )
    .limit(PAGE_SIZE)
    .offset((safePage - 1) * PAGE_SIZE);

  return (
    <PageShell size="reading">
      <Link
        href="/profile"
        className="mobile-touch-target mb-5 inline-flex items-center gap-1.5 text-[13px] font-medium text-muted hover:text-strong"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        Memory overview
      </Link>
      <PageHeader title={viewCopy[view].title} intro={viewCopy[view].intro} />

      <div className="mt-6 grid min-w-0 gap-3 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center">
        <nav className={segmentedControlClass} aria-label="Memory views">
          {VIEWS.map((item) => (
            <Link
              key={item}
              href={hrefFor(item, query)}
              aria-current={item === view ? 'page' : undefined}
              className={`${segmentedItemClass} ${
                item === view ? 'bg-raised text-strong shadow-sm' : ''
              }`}
            >
              {viewCopy[item].label}
            </Link>
          ))}
        </nav>
        <form action="/profile/memories" method="get" className="flex min-w-0 gap-2">
          <input type="hidden" name="view" value={view} />
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
              placeholder="Search what AI Bot remembers"
              className={`${inputClass} w-full pl-9`}
            />
          </label>
          <button type="submit" className={btn.outline}>
            Search
          </button>
        </form>
      </div>

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
          {rows.map(({ memory, subjectLabel }) => (
            <FactRow
              key={memory.id}
              fact={toFactView(memory, now, subjectLabel)}
              quarantine={view === 'review'}
            />
          ))}
        </div>
      )}

      {totalPages > 1 ? (
        <nav className="mt-6 flex items-center justify-between gap-3" aria-label="Memory pages">
          {safePage > 1 ? (
            <Link href={hrefFor(view, query, safePage - 1)} className={btn.outline}>
              <ChevronLeft className="size-4" aria-hidden="true" />
              Previous
            </Link>
          ) : (
            <span />
          )}
          {safePage < totalPages ? (
            <Link href={hrefFor(view, query, safePage + 1)} className={btn.outline}>
              Next
              <ChevronRight className="size-4" aria-hidden="true" />
            </Link>
          ) : null}
        </nav>
      ) : null}
    </PageShell>
  );
}
