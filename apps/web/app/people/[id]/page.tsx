import { getPersonDossier } from '@assistant/application/people';
import {
  birthdayLabel,
  eventDateLabel,
  lastContactLabel,
  PERSON_GROUP_LABELS,
} from '@assistant/application/people-presentation';
import type { MemorySnapshot } from '@assistant/application/profile';
import { CalendarDays, Handshake, MapPin, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PersonAvatar } from '@/app/people/person-avatar';
import { ConnectionList, RelationshipList } from '@/app/people/relationship-list';
import { AddFact } from '@/app/profile/add-fact';
import { FactRow, type FactView } from '@/app/profile/fact-row';
import { MergeControl } from '@/app/profile/merge-control';
import { OccasionsPanel } from '@/app/profile/occasions-panel';
import { DeletePerson, PersonControls } from '@/app/profile/person-controls';
import { requireOwner } from '@/auth';
import { relativeTime } from '@/lib/format';
import { getDb } from '@/lib/server';
import {
  Badge,
  EmptyState,
  InfoGrid,
  InfoItem,
  labelClass,
  MetaLine,
  PageHeader,
  PageShell,
  Panel,
  SectionHeading,
  summaryClass,
} from '@/lib/ui';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FACT_LIMIT = 250;

function toFactView(memory: MemorySnapshot, now: Date, subjectLabel: string): FactView {
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
    aboutOwner: false,
    originTrust: memory.originTrust,
    sourceTaskId: memory.sourceTaskId,
    subjectLabel,
    createdLabel: relativeTime(memory.createdAt, now),
    validityLabel: from ? `${from}–${until ?? 'now'}` : '',
  };
}

/** "birthday" / "anniversary" / the owner's own word for a custom occasion. */
function occasionNoun(kind: string, label: string): string {
  if (kind === 'custom') return label || 'occasion';
  return kind;
}

export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwner();
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const db = getDb();
  const now = new Date();
  const dossier = await getPersonDossier(db, id, { factLimit: FACT_LIMIT, now });
  if (!dossier) notFound();

  const { profile, birthday, location, origins, relations, connections, events } = dossier;
  const { contact, facts, totalFacts, occasions, occasionSuggestions, mergeOptions, duplicate } =
    profile;
  const lastContact = lastContactLabel(dossier.lastContactAt, now);
  const groupLabel = dossier.group === 'other' ? null : PERSON_GROUP_LABELS[dossier.group];

  return (
    <PageShell size="reading">
      <PageHeader
        back={{ href: '/people', label: 'People' }}
        title={contact.name}
        intro={
          contact.relationship
            ? undefined
            : 'No relationship recorded yet. Add one below and the assistant will treat them as a known contact.'
        }
      />

      {/* The identity line: who they are to you, where they are, when you last
          spoke. Every segment is dropped when its source is empty, so this
          never renders a dangling separator or an empty claim. */}
      <div className="mt-4 flex min-w-0 items-start gap-4">
        <PersonAvatar name={contact.name} size="lg" />
        <div className="min-w-0 flex-1">
          <MetaLine
            segments={[
              contact.relationship || 'Relationship not set',
              location ? (
                <>
                  <MapPin className="size-3.5" aria-hidden="true" />
                  {location}
                </>
              ) : null,
              lastContact,
            ]}
            className="text-sm"
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {groupLabel ? <Badge tone="muted">{groupLabel}</Badge> : null}
            {contact.trust === 'unknown' ? (
              <Badge
                tone="amber"
                size="xs"
                title="The assistant doesn't know who this is yet, so content from them is treated as untrusted. Saving a relationship marks them as known."
              >
                Unverified
              </Badge>
            ) : null}
          </div>
        </div>
      </div>

      {/* Birthday and how you met. The panel disappears entirely rather than
          showing two "not recorded" rows on a person you have just added. */}
      {birthday || origins.length > 0 ? (
        <Panel className="mt-6">
          {/* One column when only one of the two is recorded, so the panel does
              not reserve a visibly empty half. */}
          <InfoGrid columns={birthday && origins.length > 0 ? 2 : 1}>
            {birthday ? (
              <InfoItem label="Birthday">
                <span className="flex items-center gap-2">
                  <CalendarDays className="size-4 shrink-0 text-muted" aria-hidden="true" />
                  {birthdayLabel(birthday, now)}
                </span>
              </InfoItem>
            ) : null}
            {origins.length > 0 ? (
              <InfoItem label="How you met">
                <span className="flex items-start gap-2">
                  <Handshake className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />
                  <span>
                    {origins.map((origin) => (
                      <span key={origin.id} className="block">
                        {origin.sentence}
                      </span>
                    ))}
                  </span>
                </span>
              </InfoItem>
            ) : null}
          </InfoGrid>
        </Panel>
      ) : null}

      {/* Relationships to other people — the section this page exists for. */}
      <section className="mt-8">
        <SectionHeading title="Relationships" count={relations.length} />
        {relations.length === 0 ? (
          <EmptyState>
            No connections to other people are recorded yet. They are extracted from what you tell
            the assistant, and you can add one by hand in the{' '}
            <Link href="/profile/knowledge?view=map" className="text-accent underline">
              knowledge graph
            </Link>
            .
          </EmptyState>
        ) : (
          <RelationshipList relations={relations} now={now} />
        )}
      </section>

      {/* Everything else the graph knows: employers, places, events. */}
      {connections.length > 0 ? (
        <section className="mt-8">
          <SectionHeading title="Also connected" count={connections.length} />
          <ConnectionList connections={connections} now={now} />
        </section>
      ) : null}

      {/* What happened, most recent first. */}
      <section className="mt-8">
        <SectionHeading title="Recently" count={events.length} />
        {events.length === 0 ? (
          <EmptyState>
            Nothing has been recorded about time spent with {contact.name}. Mention it in a
            conversation and the assistant will note it here.
          </EmptyState>
        ) : (
          <>
            <ol className="mt-3 flex flex-col gap-2">
              {events.map((event) => (
                <li
                  key={event.id}
                  className="flex min-w-0 gap-3 rounded-xl bg-raised p-3.5 ring-1 ring-edge/60"
                >
                  <span
                    aria-hidden="true"
                    className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent"
                  >
                    <Sparkles className="size-3.5" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm leading-6 text-pretty text-strong">{event.content}</p>
                    <MetaLine
                      segments={[
                        eventDateLabel(event.occurredAt, now),
                        // A row dated only by when the assistant wrote it must
                        // not be read as the date the thing happened.
                        event.dateIsRecordTime ? 'as recorded' : null,
                        event.originTrust === 'owner' ? null : `from ${event.originTrust}`,
                      ]}
                    />
                  </div>
                </li>
              ))}
            </ol>
            <p className="mt-2 text-xs text-muted">
              What happened is kept for 90 days; lasting details are saved as facts below.
            </p>
          </>
        )}
      </section>

      {/* A reminder strip, but only ever backed by a real occasion inside its
          own lead window — the same one that reaches the morning brief. */}
      {dossier.upcomingOccasion ? (
        <section className="mt-6 rounded-2xl border border-accent/25 bg-accent/[0.06] p-4">
          <p className="text-sm font-semibold text-strong">
            {contact.name.split(' ')[0]}’s{' '}
            {occasionNoun(dossier.upcomingOccasion.kind, dossier.upcomingOccasion.label)}{' '}
            {dossier.upcomingOccasion.daysUntil === 0
              ? 'is today'
              : dossier.upcomingOccasion.daysUntil === 1
                ? 'is tomorrow'
                : `is in ${dossier.upcomingOccasion.daysUntil} days`}
          </p>
          <p className="mt-0.5 text-xs text-muted">
            Reminder · the assistant will raise it in your morning brief.
          </p>
        </section>
      ) : null}

      {/* Saved facts: durable knowledge, as distinct from what happened. */}
      <section className="mt-8">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <SectionHeading title="Saved facts" count={totalFacts} />
          <AddFact subjectContactId={contact.id} subjectLabel={contact.name} />
        </div>
        {totalFacts > FACT_LIMIT ? (
          <p className="mt-1 text-xs text-muted">
            Showing the {FACT_LIMIT} most relevant facts to keep this page quick to open.
          </p>
        ) : null}
        {facts.length === 0 ? (
          <EmptyState>No facts are saved about {contact.name} yet.</EmptyState>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            {facts.map((fact) => (
              <FactRow key={fact.id} fact={toFactView(fact, now, contact.name)} />
            ))}
          </div>
        )}
      </section>

      <OccasionsPanel
        contactId={contact.id}
        personName={contact.name}
        occasions={occasions}
        suggestions={occasionSuggestions}
      />

      {/* Editing lives below the reading material, not above it: this page is
          about the person first and a record to maintain second. */}
      <Panel className="mt-8">
        <details>
          <summary className={summaryClass}>
            Manage this person
            <span className="text-xs font-normal text-muted">
              Name, aliases, relationship, merge, delete
            </span>
          </summary>
          <p className="mt-3 max-w-[62ch] text-sm leading-5 text-muted">
            How the assistant recognises {contact.name}. Adding a relationship marks them as known,
            so their content is no longer treated as unverified.
          </p>
          <PersonControls
            contactId={contact.id}
            initialName={contact.name}
            initialAliases={contact.aliases}
            initialRelationship={contact.relationship}
          />
          <div className="mt-6 border-t border-edge pt-4">
            <p className={labelClass}>Merge or remove</p>
            <p className="mt-1 max-w-[62ch] text-xs text-muted">
              Merging moves every fact onto the person you pick and retires this entry. Deleting
              removes {contact.name} and their facts for good.
            </p>
            <div className="mt-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
              <MergeControl contactId={contact.id} options={mergeOptions} suggested={duplicate} />
              <DeletePerson contactId={contact.id} name={contact.name} returnTo="/people" />
            </div>
          </div>
        </details>
      </Panel>
    </PageShell>
  );
}
