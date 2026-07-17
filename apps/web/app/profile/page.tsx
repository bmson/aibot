import { type ContactRow, contacts, type MemoryRow, memories, ownerCard } from '@assistant/db';
import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { recompileCard, updateContactRelationship } from '@/app/profile/actions';
import { FactRow, type FactView } from '@/app/profile/fact-row';
import { MergeControl } from '@/app/profile/merge-control';
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

function toFactView(m: MemoryRow, now: Date): FactView {
  const from = m.validFrom?.toISOString().slice(0, 10);
  const until = m.validUntil?.toISOString().slice(0, 10);
  return {
    id: m.id,
    content: m.content,
    kind: m.kind,
    domain: m.domain ?? '',
    confidence: Number(m.confidence),
    ownerConfirmed: m.ownerConfirmed,
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
      .orderBy(desc(memories.importance), desc(memories.confidence)),
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

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-xl font-semibold">Profile</h1>
      <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
        What the assistant knows — about {owner?.name ?? 'the owner'} and the people around them.
        Confirm what's right, correct what's wrong, forget what shouldn't be here.
      </p>

      {/* Owner card */}
      <section className="mt-8">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium">Compiled owner card</h2>
          <form action={recompileCard}>
            <button
              type="submit"
              className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Recompile
            </button>
          </form>
        </div>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
          Injected into every planning and chat prompt.
          {card ? ` Compiled ${formatDateTime(card.compiledAt)} UTC.` : ' Not compiled yet.'}
        </p>
        {card?.content ? (
          <pre className="mt-3 overflow-x-auto rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-xs whitespace-pre-wrap dark:border-zinc-800 dark:bg-zinc-900">
            {card.content}
          </pre>
        ) : (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
            Nothing compiled yet — it builds nightly after memory extraction, or hit Recompile.
          </p>
        )}
      </section>

      {/* Quarantine review */}
      {quarantined.length > 0 ? (
        <section className="mt-8">
          <h2 className="flex items-baseline gap-2 text-sm font-medium">
            Quarantine review
            <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-950 dark:text-amber-300">
              {quarantined.length}
            </span>
          </h2>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
            Saved from untrusted sources — invisible to the assistant until you approve them.
          </p>
          <div className="mt-3 flex flex-col gap-2">
            {quarantined.map((m) => (
              <FactRow key={m.id} fact={toFactView(m, now)} quarantine />
            ))}
          </div>
        </section>
      ) : null}

      {/* Owner facts by domain */}
      <section className="mt-8">
        <h2 className="text-sm font-medium">{owner?.name ?? 'Owner'}</h2>
        {ownerByDomain.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
            No facts yet — they accumulate from conversations via nightly extraction.
          </p>
        ) : (
          <div className="mt-3 flex flex-col gap-5">
            {ownerByDomain.map((group) => (
              <div key={group.domain}>
                <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wide dark:text-zinc-500">
                  {group.domain}
                </h3>
                <div className="mt-2 flex flex-col gap-2">
                  {group.facts.map((m) => (
                    <FactRow key={m.id} fact={toFactView(m, now)} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* People */}
      <section className="mt-8">
        <h2 className="text-sm font-medium">People</h2>
        {people.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
            No people yet — new names in conversations become contacts automatically.
          </p>
        ) : (
          <div className="mt-3 flex flex-col gap-4">
            {people.map(({ contact, facts }) => (
              <div
                key={contact.id}
                className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm font-medium">
                    {contact.name}
                    <span className="ml-2 rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                      {contact.trust}
                    </span>
                  </p>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <form
                      action={updateContactRelationship.bind(null, contact.id)}
                      className="flex items-center gap-1.5"
                    >
                      <input
                        type="text"
                        name="relationship"
                        defaultValue={contact.relationship}
                        placeholder="relationship"
                        className="w-32 rounded-md border border-zinc-300 bg-white px-2 py-0.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
                      />
                      <button
                        type="submit"
                        className="rounded-md border border-zinc-300 px-2 py-0.5 text-[11px] font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                      >
                        Save
                      </button>
                    </form>
                    <MergeControl
                      contactId={contact.id}
                      options={allContacts
                        .filter((c) => c.id !== contact.id)
                        .map((c) => ({
                          id: c.id,
                          label: c.trust === 'owner' ? `${c.name} (you)` : c.name,
                        }))}
                    />
                  </span>
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
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
