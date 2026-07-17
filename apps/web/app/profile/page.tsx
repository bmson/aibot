import { CARD_AUTO_FACTS_PER_DOMAIN, CARD_AUTO_MIN_IMPORTANCE } from '@assistant/core';
import { type ContactRow, contacts, type MemoryRow, memories, ownerCard } from '@assistant/db';
import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { consolidateNow, recompileCard } from '@/app/profile/actions';
import { FactRow, type FactView } from '@/app/profile/fact-row';
import { MergeControl } from '@/app/profile/merge-control';
import { RelationshipForm } from '@/app/profile/relationship-form';
import { requireOwner } from '@/auth';
import { formatDateTime, relativeTime } from '@/lib/format';
import { getDb } from '@/lib/server';

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

const summaryClass =
  'flex cursor-pointer list-none items-baseline gap-2 text-sm font-medium [&::-webkit-details-marker]:hidden';
const countBadge =
  'rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400';

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

  const [allContacts, activeFacts, quarantined, [card]] = await Promise.all([
    db.select().from(contacts).orderBy(contacts.name),
    db
      .select()
      .from(memories)
      .where(and(active, sql`${memories.subjectContactId} IS NOT NULL`))
      .orderBy(desc(memories.pinned), desc(memories.importance), desc(memories.confidence)),
    db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.quarantined, true),
          or(isNull(memories.expiresAt), gt(memories.expiresAt, sql`now()`)),
        ),
      )
      .orderBy(desc(memories.createdAt)),
    db.select().from(ownerCard).where(eq(ownerCard.id, 1)).limit(1),
  ]);

  const owner = allContacts.find((c) => c.trust === 'owner');
  const ownerFacts = activeFacts.filter((m) => m.subjectContactId === owner?.id);
  const people: Array<{ contact: ContactRow; facts: MemoryRow[] }> = allContacts
    .filter((c) => c.trust !== 'owner')
    .map((contact) => ({
      contact,
      facts: activeFacts.filter((m) => m.subjectContactId === contact.id),
    }))
    .filter((p) => p.facts.length > 0 || p.contact.relationship);

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

  const pinnedCount = activeFacts.filter((m) => m.pinned).length;

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-xl font-semibold">Profile</h1>
      <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
        What the assistant knows — about {owner?.name ?? 'the owner'} and the people around them.
        Only the compiled card below is injected into prompts — pinned facts plus a couple of
        high-importance ones per domain; everything else is fetched on demand via semantic recall.
        Pin what must always be there, demote minor details.
      </p>

      {/* Quarantine review — the inbox; the only section that needs attention */}
      {quarantined.length > 0 ? (
        <section className="mt-8 rounded-lg border border-amber-200 bg-amber-50/50 p-4 dark:border-amber-900 dark:bg-amber-950/20">
          <h2 className="flex items-baseline gap-2 text-sm font-medium">
            Needs review
            <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-950 dark:text-amber-300">
              {quarantined.length}
            </span>
          </h2>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
            Saved from untrusted sources — invisible to the assistant until you approve them.
            Approved facts file themselves into the sections below.
          </p>
          <div className="mt-3 flex flex-col gap-2">
            {quarantined.map((m) => (
              <FactRow key={m.id} fact={toFactView(m, now)} quarantine />
            ))}
          </div>
        </section>
      ) : (
        <p className="mt-8 rounded-lg border border-zinc-200 p-4 text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
          Nothing needs review right now.
        </p>
      )}

      {/* Owner card — open by default: it IS the pre-context, and it's small now */}
      <section className="mt-8">
        <details open>
          <summary className={summaryClass}>
            Compiled owner card
            <span className={countBadge}>{pinnedCount} pinned</span>
            <span className="text-xs font-normal text-zinc-500 dark:text-zinc-500">
              injected into every prompt —{' '}
              {card ? `compiled ${formatDateTime(card.compiledAt)} UTC` : 'not compiled yet'}
            </span>
          </summary>
          {card?.content ? (
            <pre className="mt-3 overflow-x-auto rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-xs whitespace-pre-wrap dark:border-zinc-800 dark:bg-zinc-900">
              {card.content}
            </pre>
          ) : (
            <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
              Nothing compiled yet — it builds nightly after memory extraction, or hit Recompile.
            </p>
          )}
          <div className="mt-2 flex items-center gap-1.5">
            <form action={recompileCard}>
              <button
                type="submit"
                className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Recompile
              </button>
            </form>
            <form action={consolidateNow}>
              <button
                type="submit"
                title="Queues the consolidation job: dedupes, resolves contradictions, and merges fragmented same-topic facts into unified statements. Runs in the background — check /tasks for the result."
                className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Unify facts
              </button>
            </form>
            <span className="text-[11px] text-zinc-500 dark:text-zinc-500">
              Unify runs in the background (also nightly) — merged facts replace their raw
              fragments.
            </span>
          </div>
        </details>
      </section>

      {/* Owner facts by domain — collapsed archive, browse when needed */}
      <section className="mt-8">
        <h2 className="flex items-baseline gap-2 text-sm font-medium">
          {owner?.name ?? 'Owner'}
          <span className={countBadge}>{ownerFacts.length} facts</span>
        </h2>
        {ownerByDomain.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
            No facts yet — they accumulate from conversations via nightly extraction.
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
      </section>

      {/* People — one collapsed card per person */}
      <section className="mt-8">
        <h2 className="flex items-baseline gap-2 text-sm font-medium">
          People
          <span className={countBadge}>{people.length}</span>
        </h2>
        {people.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
            No people yet — new names in conversations become contacts automatically.
          </p>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            {people.map(({ contact, facts }) => (
              <details
                key={contact.id}
                className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
              >
                <summary className={summaryClass}>
                  {contact.name}
                  {contact.relationship ? (
                    <span className="text-xs font-normal text-zinc-500 dark:text-zinc-500">
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
                    {facts.length} fact{facts.length === 1 ? '' : 's'}
                  </span>
                </summary>
                <div className="mt-3 flex flex-wrap items-center justify-end gap-1.5">
                  <RelationshipForm contactId={contact.id} initial={contact.relationship} />
                  <MergeControl
                    contactId={contact.id}
                    options={allContacts
                      .filter((c) => c.id !== contact.id)
                      .map((c) => ({
                        id: c.id,
                        label: c.trust === 'owner' ? `${c.name} (you)` : c.name,
                      }))}
                  />
                </div>
                {facts.length > 0 ? (
                  <div className="mt-3 flex flex-col gap-2">
                    {facts.map((m) => (
                      <FactRow key={m.id} fact={toFactView(m, now)} />
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-500">No facts yet.</p>
                )}
              </details>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
