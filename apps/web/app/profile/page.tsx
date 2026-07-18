import { CARD_AUTO_FACTS_PER_DOMAIN, CARD_AUTO_MIN_IMPORTANCE } from '@assistant/core';
import { type ContactRow, contacts, type MemoryRow, memories, ownerCard } from '@assistant/db';
import { and, count, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import Link from 'next/link';
import { consolidateNow, recompileCard } from '@/app/profile/actions';
import { FactRow, type FactView } from '@/app/profile/fact-row';
import { requireOwner } from '@/auth';
import { formatDateTime, relativeTime } from '@/lib/format';
import { getDb } from '@/lib/server';
import { btn, countBadgeClass, PageHeader, summaryClass } from '@/lib/ui';

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

  const active = and(
    eq(memories.category, 'knowledge'),
    eq(memories.quarantined, false),
    or(isNull(memories.expiresAt), gt(memories.expiresAt, sql`now()`)),
  );

  const [allContacts, quarantined, [card]] = await Promise.all([
    db.select().from(contacts).orderBy(contacts.name).limit(PROFILE_CONTACT_LIMIT),
    db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.quarantined, true),
          or(isNull(memories.expiresAt), gt(memories.expiresAt, sql`now()`)),
        ),
      )
      .orderBy(desc(memories.createdAt))
      .limit(QUARANTINE_LIMIT),
    db.select().from(ownerCard).where(eq(ownerCard.id, 1)).limit(1),
  ]);

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
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Memory"
        intro={`Review what the assistant remembers about ${owner?.name ?? 'you'} and the people around you. Keep the important things accurate; everything else stays available when needed.`}
      />

      {/* Quarantine review — the inbox; the only section that needs attention */}
      {quarantined.length > 0 ? (
        <section className="mt-8 rounded-lg border border-amber-200 bg-amber-50/50 p-4 dark:border-amber-900 dark:bg-amber-950/20">
          <h2 className="flex items-baseline gap-2 text-sm font-medium">
            Review saved information
            <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-950 dark:text-amber-300">
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

      {/* Owner card — open by default: it IS the pre-context, and it's small now */}
      <section className="mt-8">
        <details open>
          <summary className={summaryClass}>
            What the assistant uses in chat
            <span className={countBadge}>{pinnedCount} pinned</span>
            <span className="text-xs font-normal text-zinc-500 dark:text-zinc-500">
              {card ? `updated ${formatDateTime(card.compiledAt)} UTC` : 'not prepared yet'}
            </span>
          </summary>
          {card?.content ? (
            <pre className="mt-3 overflow-x-auto rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-xs whitespace-pre-wrap dark:border-zinc-800 dark:bg-zinc-900">
              {card.content}
            </pre>
          ) : (
            <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
              Nothing is selected yet. Pin a fact below or refresh this summary after adding one.
            </p>
          )}
          <div className="mt-2 flex items-center gap-1.5">
            <form action={recompileCard}>
              <button type="submit" className={btn.outline}>
                Refresh summary
              </button>
            </form>
            <form action={consolidateNow}>
              <button
                type="submit"
                title="Queues a cleanup that deduplicates, resolves contradictions, and combines fragmented facts."
                className={btn.outline}
              >
                Organize memory
              </button>
            </form>
            <span className="text-[11px] text-zinc-500 dark:text-zinc-500">
              Combines duplicate or fragmented facts. You can keep using the app while it runs.
            </span>
          </div>
        </details>
      </section>

      {/* Owner facts by domain — collapsed archive, browse when needed */}
      <section className="mt-8">
        <details>
          <summary className={summaryClass}>
            All saved details about {owner?.name ?? 'you'}
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
                  <details
                    key={group.domain}
                    className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
                  >
                    <summary className={summaryClass}>
                      <span className="text-xs font-medium text-zinc-600 uppercase tracking-wide dark:text-zinc-400">
                        {group.domain}
                      </span>
                      <span className={countBadge}>{group.facts.length}</span>
                      {pinnedInDomain > 0 ? (
                        <span className="text-[10px] text-blue-700 dark:text-blue-400">
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
      </section>

      {/* People — one collapsed card per person */}
      <section className="mt-8">
        <h2 className="flex items-baseline gap-2 text-sm font-medium">
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
          <div className="mt-3 flex flex-col gap-2">
            {people.map(({ contact, factCount }) => (
              <Link
                key={contact.id}
                href={`/profile/people/${contact.id}`}
                className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 p-3 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900/50"
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
                        className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300"
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
    </div>
  );
}
