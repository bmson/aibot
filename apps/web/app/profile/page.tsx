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
} from '@assistant/db';
import { and, count, desc, eq, gt, inArray, isNull, like, or, sql } from 'drizzle-orm';
import { Brain, CheckCircle2, ShieldQuestion, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { consolidateNow, recompileCard } from '@/app/profile/actions';
import { FactRow, type FactView } from '@/app/profile/fact-row';
import { type VoiceImportView, VoiceSamplesPanel } from '@/app/profile/voice-samples';
import { requireOwner } from '@/auth';
import { relativeTime } from '@/lib/format';
import { getDb } from '@/lib/server';
import { btn, countBadgeClass, PageHeader, PageShell, Panel, summaryClass } from '@/lib/ui';

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

function toFactView(m: MemoryRow, now: Date, inCard = false): FactView {
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
    inCard,
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

  const [allContacts, quarantined, [card], voiceStats, voiceImports, memoryHealth] =
    await Promise.all([
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
    ]);
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

  return (
    <PageShell size="reading">
      <PageHeader
        title="What I remember"
        intro={`See what shapes AI Bot’s understanding of ${owner?.name ?? 'you'}, what still needs care, and what stays available for recall.`}
      />

      <Panel tone="sunken" className="mt-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-xl">
            <div className="flex items-center gap-2">
              <Brain className="size-4 text-accent" aria-hidden="true" />
              <h2 className="text-lg font-semibold tracking-[-0.02em]">Memory health</h2>
            </div>
            <p className="mt-2 text-[15px] leading-6 text-muted">
              {memoryHealth.notYetOrganized === 0
                ? 'Everything usable has passed through memory organization.'
                : `${memoryHealth.notYetOrganized} usable memor${
                    memoryHealth.notYetOrganized === 1 ? 'y has' : 'ies have'
                  } not been organized yet.`}
            </p>
          </div>
          {memoryHealth.notYetOrganized > 0 ? (
            <form action={consolidateNow}>
              <button type="submit" className={btn.primary}>
                <Sparkles className="size-4" aria-hidden="true" />
                Organize memory
              </button>
            </form>
          ) : null}
        </div>
        <div className="mt-6 grid grid-cols-2 gap-x-5 gap-y-4 border-t border-edge pt-5 sm:grid-cols-4">
          {[
            { value: memoryHealth.totalUsable, label: 'Usable memories' },
            { value: memoryHealth.notYetOrganized, label: 'Not yet organized' },
            { value: memoryHealth.awaitingReview, label: 'Awaiting review' },
            { value: memoryHealth.ownerConfirmed, label: 'Owner-confirmed' },
          ].map((item) => (
            <div key={item.label}>
              <p className="font-display text-2xl font-semibold tracking-[-0.03em]">{item.value}</p>
              <p className="mt-0.5 text-xs leading-5 text-muted">{item.label}</p>
            </div>
          ))}
        </div>
        <p className="mt-5 text-xs leading-5 text-muted">
          {memoryHealth.lastOrganizedAt
            ? `Last organized ${relativeTime(memoryHealth.lastOrganizedAt, now)}.`
            : 'Memory organization has not completed yet.'}{' '}
          Isolated facts may not need merging, but the count always reflects whether they have been
          reviewed by the organization pass.
        </p>
      </Panel>

      {/* Quarantine review — the inbox; the only section that needs attention */}
      {quarantined.length > 0 ? (
        <section className="mt-6 rounded-2xl border border-amber-200 bg-amber-50/65 p-5 dark:border-amber-900 dark:bg-amber-950/20">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold">
            <ShieldQuestion
              className="size-4 text-amber-700 dark:text-amber-300"
              aria-hidden="true"
            />
            Awaiting your review
            <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-2xs font-semibold text-amber-800 dark:bg-amber-950 dark:text-amber-300">
              {quarantined.length}
            </span>
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
            <div className="mt-4 max-h-52 overflow-y-auto rounded-xl bg-sunken/60 p-4 text-[13px] leading-6 whitespace-pre-wrap text-strong">
              {card.content}
            </div>
          ) : (
            <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
              Nothing is selected yet. Pin a fact below or refresh this summary after adding one.
            </p>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <form action={recompileCard}>
              <button type="submit" className={btn.outline}>
                Refresh summary
              </button>
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
              Open when you need to edit or verify something.
            </span>
          </summary>
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
                        <FactRow key={m.id} fact={toFactView(m, now, cardFactIds.has(m.id))} />
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
                className="flex items-center justify-between gap-3 rounded-2xl bg-raised p-4 shadow-[0_1px_2px_rgb(23_25_35/0.06)] motion-safe:transition-transform hover:-translate-y-0.5"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{contact.name}</span>
                    {contact.relationship ? (
                      <span className="text-xs text-zinc-500 dark:text-zinc-500">
                        {contact.relationship}
                      </span>
                    ) : null}
                    {contact.trust === 'unknown' ? (
                      <span
                        className="rounded-full bg-amber-100 px-1.5 py-0.5 text-2xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                        title="The assistant doesn't know who this is yet, so content from them is treated as untrusted. Saving a relationship marks them as known."
                      >
                        unverified
                      </span>
                    ) : null}
                    <span className={countBadge}>
                      {factCount} fact{factCount === 1 ? '' : 's'}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
                    Open to review facts and edit this person.
                  </p>
                </div>
                <span className="shrink-0 text-xs font-medium text-blue-700 dark:text-blue-400">
                  Open
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </PageShell>
  );
}
