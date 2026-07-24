import { detectOccasionInText, listOccasionsForContact } from '@assistant/core';
import { contacts, findDuplicateContactSuggestions, type MemoryRow, memories } from '@assistant/db';
import { and, count, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AddFact } from '@/app/profile/add-fact';
import { FactRow, type FactView } from '@/app/profile/fact-row';
import { MergeControl } from '@/app/profile/merge-control';
import {
  type OccasionSuggestion,
  OccasionsPanel,
  type OccasionView,
} from '@/app/profile/occasions-panel';
import { PersonControls } from '@/app/profile/person-controls';
import { RelationshipForm } from '@/app/profile/relationship-form';
import { requireOwner } from '@/auth';
import { relativeTime } from '@/lib/format';
import { getDb } from '@/lib/server';
import { countBadgeClass, PageHeader, PageShell, Panel } from '@/lib/ui';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FACT_LIMIT = 250;

function toFactView(memory: MemoryRow, now: Date, subjectLabel: string): FactView {
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
    // This page never shows the owner (guarded above), so facts here reach the
    // profile summary only by pinning.
    aboutOwner: false,
    originTrust: memory.originTrust,
    sourceTaskId: memory.sourceTaskId,
    // Every fact on this page is about this person — the row must not fall back
    // to the owner's "You" label.
    subjectLabel,
    createdLabel: relativeTime(memory.createdAt, now),
    validityLabel: from ? `${from}–${until ?? 'now'}` : '',
  };
}

export default async function PersonProfilePage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwner();
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const db = getDb();
  const now = new Date();
  const [contact] = await db.select().from(contacts).where(eq(contacts.id, id)).limit(1);
  if (!contact || contact.trust === 'owner') notFound();

  const active = and(
    eq(memories.category, 'knowledge'),
    eq(memories.quarantined, false),
    or(isNull(memories.expiresAt), gt(memories.expiresAt, sql`now()`)),
  );
  const [facts, [factCount], allContacts, occasionRows] = await Promise.all([
    db
      .select()
      .from(memories)
      .where(and(active, eq(memories.subjectContactId, contact.id)))
      .orderBy(desc(memories.pinned), desc(memories.importance), desc(memories.confidence))
      .limit(FACT_LIMIT),
    db
      .select({ n: count() })
      .from(memories)
      .where(and(active, eq(memories.subjectContactId, contact.id))),
    db.select().from(contacts).orderBy(contacts.name).limit(500),
    listOccasionsForContact(db, contact.id),
  ]);
  const occasionViews: OccasionView[] = occasionRows.map((o) => ({
    id: o.id,
    kind: o.kind,
    label: o.label,
    month: o.month,
    day: o.day,
    year: o.year,
    notes: o.notes,
    quarantined: o.quarantined,
  }));

  // Offer to lift a birthday/anniversary stated in a fact into an Occasion when
  // the person has no occasion on that date yet. Consolidation backfills these
  // nightly too; the chip just makes it immediate and owner-controlled.
  const existingDates = new Set(occasionRows.map((o) => `${o.month}-${o.day}`));
  const suggestionSeen = new Set<string>();
  const occasionSuggestions: OccasionSuggestion[] = [];
  for (const fact of facts) {
    const detected = detectOccasionInText(fact.content);
    if (!detected) continue;
    const key = `${detected.month}-${detected.day}`;
    if (existingDates.has(key) || suggestionSeen.has(key)) continue;
    suggestionSeen.add(key);
    occasionSuggestions.push(detected);
  }
  const totalFacts = Number(factCount?.n ?? 0);
  const mergeOptions = allContacts
    .filter((person) => person.id !== contact.id)
    .map((person) => ({
      id: person.id,
      label: person.relationship ? `${person.name} (${person.relationship})` : person.name,
    }));
  const duplicate = findDuplicateContactSuggestions(allContacts).find(
    (suggestion) => suggestion.contactId === contact.id,
  );

  return (
    <PageShell size="reading">
      <Link
        href="/profile"
        className="mb-5 inline-flex items-center gap-1.5 text-[13px] font-medium text-muted hover:text-strong"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        Memory overview
      </Link>
      <PageHeader
        title={contact.name}
        intro="Review the facts the assistant associates with this person. Update the identity or relationship when needed; changes take effect in future conversations."
      />

      <Panel className="mt-6">
        <h2 className="text-sm font-medium">Person details</h2>
        <div className="mt-3 grid gap-4 lg:grid-cols-2">
          <div>
            <p className="mb-1 text-xs text-zinc-500 dark:text-zinc-400">Name and aliases</p>
            <PersonControls
              contactId={contact.id}
              initialName={contact.name}
              initialAliases={contact.aliases}
            />
          </div>
          <div>
            <p className="mb-1 text-xs text-zinc-500 dark:text-zinc-400">Relationship</p>
            <RelationshipForm contactId={contact.id} initial={contact.relationship} />
            <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
              Adding a relationship marks this person as known, so their content is no longer
              treated as unverified.
            </p>
          </div>
        </div>
        <div className="mt-4 border-t border-edge pt-4">
          <p className="mb-1 text-xs text-zinc-500 dark:text-zinc-400">Possible duplicate</p>
          <MergeControl contactId={contact.id} options={mergeOptions} suggested={duplicate} />
        </div>
      </Panel>

      <OccasionsPanel
        contactId={contact.id}
        personName={contact.name}
        occasions={occasionViews}
        suggestions={occasionSuggestions}
      />

      <section className="mt-8">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="flex items-baseline gap-2 text-sm font-medium">
            Saved facts
            <span className={countBadgeClass}>{totalFacts}</span>
          </h2>
          <AddFact subjectContactId={contact.id} subjectLabel={contact.name} />
        </div>
        {totalFacts > FACT_LIMIT ? (
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            Showing the {FACT_LIMIT} most relevant facts to keep this page quick to open.
          </p>
        ) : null}
        {facts.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
            No active facts are saved for this person.
          </p>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            {facts.map((fact) => (
              <FactRow key={fact.id} fact={toFactView(fact, now, contact.name)} />
            ))}
          </div>
        )}
      </section>
    </PageShell>
  );
}
