import {
  CARD_AUTO_FACTS_PER_DOMAIN,
  CARD_AUTO_MIN_IMPORTANCE,
  getAgent,
  getMemoryHealth,
  voiceSampleStats,
} from '@assistant/core';
import {
  type ContactRow,
  contacts,
  importSources,
  type MemoryRow,
  memories,
  ownerCard,
  tasks,
} from '@assistant/db';
import { and, count, desc, eq, gt, inArray, isNull, like, or, sql } from 'drizzle-orm';
import { ArrowRight, CheckCircle2, Library, ShieldQuestion } from 'lucide-react';
import Link from 'next/link';
import { AutoRefresh } from '@/app/auto-refresh';
import { recompileCard } from '@/app/profile/actions';
import { AddFact } from '@/app/profile/add-fact';
import { AddPerson } from '@/app/profile/add-person';
import { FactRow, type FactView } from '@/app/profile/fact-row';
import { MemoryOrganizer } from '@/app/profile/memory-organizer';
import { type VoiceImportView, VoiceSamplesPanel } from '@/app/profile/voice-samples';
import { requireOwner } from '@/auth';
import { relativeTime } from '@/lib/format';
import { getDb } from '@/lib/server';
import {
  Badge,
  btn,
  CountBadge,
  cardInteractiveClass,
  cardShellClass,
  countBadgeClass,
  PageHeader,
  PageShell,
  Panel,
  summaryClass,
} from '@/lib/ui';
import { SubmitButton } from '@/lib/ui-client';

export const metadata = { title: 'Memory' };

export const dynamic = 'force-dynamic';

const DOMAIN_ORDER = [
  'identity',
  'work',
  'home',
  'relationships',
  'preferences',
  'health',
  'other',
] as const;

const countBadge = countBadgeClass;
const PROFILE_CONTACT_LIMIT = 500;
const PROFILE_FACT_LIMIT = 250;
const QUARANTINE_LIMIT = 100;
const VOICE_IMPORT_LIMIT = 5;

function toFactView(m: MemoryRow, now: Date, inCard = false, aboutOwner = false): FactView {
  const from = m.validFrom?.toISOString().slice(0, 10);
  const until = m.validUntil?.toISOString().slice(0, 10);
  return {
    id: m.id,
    content: m.content,
    kind: m.kind,
    domain: m.domain ?? '',
    confidence: Number(m.confidence),
    importance: m.importance,
    ownerConfirmed: m.ownerConfirmed,
    pinned: m.pinned,
    organized: m.lastConsolidatedAt !== null,
    inCard,
    aboutOwner,
    originTrust: m.originTrust,
    sourceTaskId: m.sourceTaskId,
    createdLabel: relativeTime(m.createdAt, now),
    validityLabel: from ? `${from}–${until ?? 'now'}` : '',
  };
}

export default async function ProfilePage() {
  await requireOwner();
  const db = getDb();
  const now = new Date();
  const agent = await getAgent(db);

  const active = and(
    eq(memories.agentId, agent.id),
    eq(memories.category, 'knowledge'),
    eq(memories.quarantined, false),
    or(isNull(memories.expiresAt), gt(memories.expiresAt, sql`now()`)),
  );

  const [
    allContacts,
    quarantined,
    [card],
    voiceStats,
    voiceImports,
    memoryHealth,
    latestOrganizerRows,
  ] = await Promise.all([
    db.select().from(contacts).orderBy(contacts.name).limit(PROFILE_CONTACT_LIMIT),
    db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.agentId, agent.id),
          eq(memories.category, 'knowledge'),
          eq(memories.quarantined, true),
          or(isNull(memories.expiresAt), gt(memories.expiresAt, sql`now()`)),
        ),
      )
      .orderBy(desc(memories.createdAt))
      .limit(QUARANTINE_LIMIT),
    db.select().from(ownerCard).where(eq(ownerCard.id, 1)).limit(1),
    voiceSampleStats(db),
    db
      .select()
      .from(importSources)
      .where(like(importSources.source, 'voice-samples%'))
      .orderBy(desc(importSources.updatedAt))
      .limit(VOICE_IMPORT_LIMIT),
    getMemoryHealth(db, agent.id),
    db
      .select({
        id: tasks.id,
        status: tasks.status,
        progress: tasks.progress,
        updatedAt: tasks.updatedAt,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.agentId, agent.id),
          sql`${tasks.trigger} #>> '{payload,job}' = 'memory.consolidate'`,
        ),
      )
      .orderBy(desc(tasks.createdAt))
      .limit(1),
  ]);
  const latestOrganizer = latestOrganizerRows[0] ?? null;
  const voiceImportViews: VoiceImportView[] = voiceImports.map((row) => ({
    source: row.source,
    status: row.status,
    itemsTotal: row.itemsTotal,
    itemsProcessed: row.itemsProcessed,
    memoriesSaved: row.memoriesSaved,
    taskId: row.taskId,
    error: row.error,
  }));

  const owner = allContacts.find((c) => c.trust === 'owner');
  const contactIds = allContacts.map((contact) => contact.id);
  // The old page loaded and rendered every fact for every person (up to 1,000
  // records) before the owner could see anything. Keep this overview to the
  // owner's facts plus inexpensive counts; each person's facts load only when
  // their detail page is opened.
  const [ownerFacts, factCountRows] = await Promise.all([
    owner
      ? db
          .select()
          .from(memories)
          .where(and(active, eq(memories.subjectContactId, owner.id)))
          .orderBy(desc(memories.pinned), desc(memories.importance), desc(memories.confidence))
          .limit(PROFILE_FACT_LIMIT)
      : Promise.resolve([] as MemoryRow[]),
    contactIds.length > 0
      ? db
          .select({ contactId: memories.subjectContactId, n: count() })
          .from(memories)
          .where(and(active, inArray(memories.subjectContactId, contactIds)))
          .groupBy(memories.subjectContactId)
      : Promise.resolve([]),
  ]);
  const factCounts = new Map(factCountRows.map((row) => [row.contactId ?? '', Number(row.n)]));
  const people: Array<{ contact: ContactRow; factCount: number }> = allContacts
    .filter((c) => c.trust !== 'owner')
    .map((contact) => ({
      contact,
      factCount: factCounts.get(contact.id) ?? 0,
    }));

  const ownerByDomain = DOMAIN_ORDER.map((domain) => ({
    domain,
    facts: ownerFacts.filter((m) => (m.domain ?? 'other') === domain),
  })).filter((g) => g.facts.length > 0);

  // mirror compileOwnerCard's selection so rows can show an "in card" badge
  const cardFactIds = new Set<string>();
  for (const group of ownerByDomain) {
    for (const m of group.facts.filter((f) => f.pinned)) cardFactIds.add(m.id);
    for (const m of group.facts
      .filter((f) => !f.pinned && f.importance >= CARD_AUTO_MIN_IMPORTANCE)
      .slice(0, CARD_AUTO_FACTS_PER_DOMAIN)) {
      cardFactIds.add(m.id);
    }
  }

  const pinnedCount = ownerFacts.filter((m) => m.pinned).length;

  // Memory state only changes nightly or from an action on this page (which
  // revalidates on its own). The one thing that updates in the background is a
  // running consolidation pass — so poll only while one is active, instead of
  // re-running every query on this page every 8 seconds.
  const organizerActive =
    latestOrganizer?.status === 'pending' || latestOrganizer?.status === 'running';

  return (
    <PageShell size="reading">
      {organizerActive ? <AutoRefresh intervalMs={5_000} /> : null}
      <PageHeader
        title="What I remember"
        intro={`See what shapes AI Bot’s understanding of ${owner?.name ?? 'you'}, what still needs care, and what stays available for recall.`}
      />

      <section className="mt-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-[-0.025em]">Your memory library</h2>
            <p className="mt-1 text-[13px] leading-5 text-muted">
              Everything AI Bot has learned, with controls to verify, correct, feature, or forget
              each fact.
            </p>
          </div>
          <Link href="/profile/memories" className={`${btn.outline} group`}>
            Browse all
            <ArrowRight
              className="size-3.5 motion-safe:transition-transform group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </Link>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Link
            href="/profile/memories"
            className="group rounded-2xl bg-raised p-4 shadow-[0_1px_2px_rgb(23_25_35/0.06)] ring-1 ring-edge/60 motion-safe:transition-[transform,box-shadow] hover:-translate-y-0.5 hover:shadow-[0_8px_24px_rgb(23_25_35/0.08)] sm:p-5"
          >
            <div className="flex items-start justify-between gap-4">
              <span className="inline-flex size-9 items-center justify-center rounded-xl bg-accent/10 text-accent">
                <Library className="size-4" aria-hidden="true" />
              </span>
              <span className="font-display text-3xl font-semibold tracking-[-0.04em]">
                {memoryHealth.totalUsable.toLocaleString()}
              </span>
            </div>
            <p className="mt-4 text-[13px] font-semibold">In use by AI Bot</p>
            <p className="mt-1 text-xs leading-5 text-muted">
              Active facts that can be recalled in conversations
              {memoryHealth.ownerConfirmed > 0
                ? ` — ${memoryHealth.ownerConfirmed.toLocaleString()} verified by you`
                : ''}
              .
            </p>
            <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-accent">
              Browse and manage
              <ArrowRight
                className="size-3 motion-safe:transition-transform group-hover:translate-x-0.5"
                aria-hidden="true"
              />
            </span>
          </Link>

          <Link
            href="/profile/memories?state=review"
            className={`group rounded-2xl p-4 shadow-[0_1px_2px_rgb(23_25_35/0.06)] ring-1 motion-safe:transition-[transform,box-shadow] hover:-translate-y-0.5 hover:shadow-[0_8px_24px_rgb(23_25_35/0.08)] sm:p-5 ${
              memoryHealth.awaitingReview > 0
                ? 'bg-amber-50/70 ring-amber-200 dark:bg-amber-950/20 dark:ring-amber-900'
                : 'bg-raised ring-edge/60'
            }`}
          >
            <div className="flex items-start justify-between gap-4">
              <span
                className={`inline-flex size-9 items-center justify-center rounded-xl ${
                  memoryHealth.awaitingReview > 0
                    ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
                    : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                }`}
              >
                {memoryHealth.awaitingReview > 0 ? (
                  <ShieldQuestion className="size-4" aria-hidden="true" />
                ) : (
                  <CheckCircle2 className="size-4" aria-hidden="true" />
                )}
              </span>
              <span className="font-display text-3xl font-semibold tracking-[-0.04em]">
                {memoryHealth.awaitingReview.toLocaleString()}
              </span>
            </div>
            <p className="mt-4 text-[13px] font-semibold">
              {memoryHealth.awaitingReview > 0 ? 'Waiting on you' : 'Nothing to review'}
            </p>
            <p className="mt-1 text-xs leading-5 text-muted">
              {memoryHealth.awaitingReview > 0
                ? 'Held back until you approve the source. Not used in conversations yet.'
                : 'Everything from unverified sources has been reviewed.'}
            </p>
            <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-accent">
              {memoryHealth.awaitingReview > 0 ? 'Review now' : 'View'}
              <ArrowRight
                className="size-3 motion-safe:transition-transform group-hover:translate-x-0.5"
                aria-hidden="true"
              />
            </span>
          </Link>
        </div>
        <div className="mt-4">
          <MemoryOrganizer
            remaining={memoryHealth.notYetOrganized}
            latest={
              latestOrganizer
                ? {
                    id: latestOrganizer.id,
                    status: latestOrganizer.status,
                    progress: latestOrganizer.progress,
                    updatedLabel: relativeTime(latestOrganizer.updatedAt, now),
                  }
                : null
            }
          />
        </div>
      </section>

      {/* Quarantine review — the inbox; the only section that needs attention */}
      {quarantined.length > 0 ? (
        <section className="mt-6 rounded-2xl border border-amber-200 bg-amber-50/65 p-5 dark:border-amber-900 dark:bg-amber-950/20">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold">
            <ShieldQuestion
              className="size-4 text-amber-700 dark:text-amber-300"
              aria-hidden="true"
            />
            Awaiting your review
            <CountBadge tone="amber">{quarantined.length}</CountBadge>
          </h2>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
            These came from unverified sources. The assistant will not use them until you approve
            them.
          </p>
          <div className="mt-3 flex flex-col gap-2">
            {quarantined.map((m) => (
              <FactRow key={m.id} fact={toFactView(m, now)} quarantine />
            ))}
          </div>
        </section>
      ) : null}

      {/* The compiled chat context is useful for auditing, but secondary to the facts themselves. */}
      <Panel className="mt-6">
        <details open>
          <summary className={summaryClass}>
            Used in conversations
            <span className={countBadge}>{pinnedCount} pinned</span>
            <span className="text-xs font-normal text-zinc-500 dark:text-zinc-500">
              {card ? `refreshed ${relativeTime(card.compiledAt, now)}` : 'not prepared yet'}
            </span>
          </summary>
          {card?.content ? (
            <div className="mt-4 max-h-52 overscroll-contain overflow-y-auto rounded-xl bg-sunken/60 p-4 text-[13px] leading-6 whitespace-pre-wrap text-strong">
              {card.content}
            </div>
          ) : (
            <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
              Nothing is selected yet. Pin a fact below or refresh this summary after adding one.
            </p>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <form action={recompileCard}>
              <SubmitButton variant="outline" pendingLabel="Refreshing…">
                Refresh summary
              </SubmitButton>
            </form>
            <span className="text-xs text-muted">
              This compact context is what AI Bot sees before it searches deeper memory.
            </span>
          </div>
        </details>
      </Panel>

      {/* Owner facts by domain — collapsed archive, browse when needed */}
      <Panel className="mt-6">
        <details>
          <summary className={summaryClass}>
            About {owner?.name ?? 'you'}
            <span className={countBadge}>{ownerFacts.length} facts</span>
            <span className="text-xs font-normal text-zinc-500 dark:text-zinc-500">
              Open when you need to edit, add, or verify something.
            </span>
          </summary>
          {owner ? (
            <div className="mt-3">
              <AddFact subjectContactId={owner.id} subjectLabel="you" />
            </div>
          ) : null}
          {ownerByDomain.length === 0 ? (
            <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
              No details yet — they are added from conversations only after review.
            </p>
          ) : (
            <div className="mt-3 flex flex-col gap-2">
              {ownerByDomain.map((group) => {
                const pinnedInDomain = group.facts.filter((m) => m.pinned).length;
                return (
                  <details key={group.domain} className="rounded-xl bg-sunken/55 p-3.5">
                    <summary className={summaryClass}>
                      <span className="text-xs font-medium text-zinc-600 uppercase tracking-wide dark:text-zinc-400">
                        {group.domain}
                      </span>
                      <span className={countBadge}>{group.facts.length}</span>
                      {pinnedInDomain > 0 ? (
                        <span className="text-2xs text-blue-700 dark:text-blue-400">
                          {pinnedInDomain} pinned
                        </span>
                      ) : null}
                    </summary>
                    <div className="mt-3 flex flex-col gap-2">
                      {group.facts.map((m) => (
                        <FactRow
                          key={m.id}
                          fact={toFactView(m, now, cardFactIds.has(m.id), true)}
                        />
                      ))}
                    </div>
                  </details>
                );
              })}
            </div>
          )}
        </details>
      </Panel>

      {/* Writing voice — sample corpus + one-time batch upload */}
      <VoiceSamplesPanel
        total={voiceStats.total}
        auto={voiceStats.auto}
        uploaded={voiceStats.uploaded}
        imports={voiceImportViews}
      />

      {/* People — one collapsed card per person */}
      <section className="mt-8">
        <h2 className="flex items-center gap-2 text-lg font-semibold tracking-[-0.02em]">
          <CheckCircle2 className="size-4 text-accent" aria-hidden="true" />
          People
          <span className={countBadge}>{people.length}</span>
        </h2>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
          Open a person to review what the assistant knows about them.
        </p>
        <div className="mt-3">
          <AddPerson />
        </div>
        {people.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
            No people yet — new names in conversations become contacts automatically.
          </p>
        ) : (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {people.map(({ contact, factCount }) => (
              <Link
                key={contact.id}
                href={`/profile/people/${contact.id}`}
                className={`${cardShellClass} ${cardInteractiveClass} group grid grid-cols-[minmax(0,1fr)_auto] gap-3 p-4`}
              >
                <div className="min-w-0">
                  <h3 className="truncate text-[15px] font-semibold tracking-[-0.01em]">
                    {contact.name}
                  </h3>
                  <p className="mt-0.5 truncate text-xs text-muted">
                    {contact.relationship || 'Relationship not set'}
                  </p>
                </div>
                <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-accent">
                  Manage
                  <ArrowRight
                    className="size-3 motion-safe:transition-transform group-hover:translate-x-0.5"
                    aria-hidden="true"
                  />
                </span>
                <div className="col-span-2 flex flex-wrap items-center gap-2 border-t border-edge/70 pt-3">
                  <span className={countBadge}>
                    {factCount} fact{factCount === 1 ? '' : 's'}
                  </span>
                  {contact.trust === 'unknown' ? (
                    <Badge
                      tone="amber"
                      size="xs"
                      title="The assistant doesn't know who this is yet, so content from them is treated as untrusted. Saving a relationship marks them as known."
                    >
                      Unverified
                    </Badge>
                  ) : (
                    <span className="text-2xs font-medium text-muted">Known contact</span>
                  )}
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </PageShell>
  );
}
