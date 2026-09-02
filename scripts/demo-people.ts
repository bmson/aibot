/**
 * Demo people for looking at the People section.
 *
 * The seed creates one contact — the owner — so `/people` renders empty on a
 * fresh database and there is nothing to review a design against. This writes a
 * small cast of six with birthdays, connections, and things that happened, so
 * every state the section can be in is on screen at once, including the empty
 * ones.
 *
 *   pnpm tsx scripts/demo-people.ts [--purge]
 *
 * Everything it writes is tagged `source: 'demo-people'` and re-running is
 * idempotent: the previous cast is removed first. `--purge` removes it and
 * stops, which is how you get a database back to seed state.
 *
 * A graph edge is only live when five separate conditions hold (see
 * `activeKnowledgeGraphWhere`): the source memory carries an embedding, its
 * extraction source row is `ready` with a matching content hash and a current
 * extraction version, the edge is not rejected, and it has an evidence quote.
 * Miss any one and the relationship silently does not render — which is most of
 * why this script exists rather than a handful of INSERTs.
 */

import { createHash } from 'node:crypto';
import { loadConfig } from '@assistant/config';
import { GRAPH_EXTRACTION_VERSION } from '@assistant/core/memory/knowledge-graph';
import {
  agents,
  contacts,
  createDb,
  knowledgeGraphEntities,
  knowledgeGraphRelations,
  knowledgeGraphSources,
  memories,
  occasions,
} from '@assistant/db';
import { eq, inArray } from 'drizzle-orm';

if (process.env.NODE_ENV === 'production') {
  throw new Error('demo-people writes fixture data and must never run against production.');
}

const SOURCE = 'demo-people';
const config = loadConfig();
const db = createDb(config.DATABASE_URL);

const [agentRow] = await db.select().from(agents).limit(1);
if (!agentRow) throw new Error('No agent row — run `pnpm db:migrate && pnpm seed` first.');
// Bound to a const so the narrowing survives into the helpers below.
const agent = agentRow;

const now = new Date();
const year = now.getUTCFullYear();
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);

/**
 * A deterministic unit vector. The column only has to be non-null for an edge
 * to count as live; similarity search over fixture rows is meaningless anyway,
 * so this costs no model call.
 */
const EMBEDDING = (() => {
  const vector = new Array<number>(1536).fill(0);
  vector[0] = 1;
  return vector;
})();

type Kind = 'person' | 'organization' | 'project' | 'place' | 'event' | 'date' | 'topic';

interface FactSpec {
  /** The sentence the edge is extracted from — shown as its evidence. */
  content: string;
  subject: string;
  predicate: string;
  object: string;
  objectKind: Kind;
  validFrom?: string;
  validUntil?: string;
}

interface EventSpec {
  content: string;
  daysAgo: number;
}

interface PersonSpec {
  name: string;
  relationship: string;
  /** Omitted entirely for the person who is meant to have no birthday. */
  birthday?: { month: number; day: number; year?: number };
  facts: FactSpec[];
  events: EventSpec[];
  /** Plain knowledge facts with no graph edge — the "Saved facts" list. */
  notes: string[];
}

/**
 * The cast is chosen to cover the states, not to be realistic: a full card, a
 * birthday within its lead window, a birthday with no year, an ended
 * relationship, someone with no graph at all, and someone with nothing but a
 * name.
 */
const PEOPLE: PersonSpec[] = [
  {
    name: 'Élise Aubert',
    relationship: 'Sister',
    birthday: { month: 3, day: 18, year: 1987 },
    facts: [
      {
        content: 'Élise Aubert lives in Lyon, where she moved after university.',
        subject: 'Élise Aubert',
        predicate: 'lives_in',
        object: 'Lyon',
        objectKind: 'place',
      },
      {
        content: 'Élise Aubert has been Marc Vidal’s partner since March 2016.',
        subject: 'Élise Aubert',
        predicate: 'partner_of',
        object: 'Marc Vidal',
        objectKind: 'person',
        validFrom: '2016-03',
      },
      {
        content: 'Élise Aubert is Léa Aubert’s parent; Léa was born in 2019.',
        subject: 'Élise Aubert',
        predicate: 'parent_of',
        object: 'Léa Aubert',
        objectKind: 'person',
        validFrom: '2019',
      },
    ],
    events: [
      {
        content: 'Lunch with Élise at Le Petit Sud; she is thinking about moving back to Lyon.',
        daysAgo: 0,
      },
      { content: 'Called Élise about Georges for twenty-two minutes.', daysAgo: 31 },
      { content: 'Élise sent photographs from the weekend in Annecy.', daysAgo: 74 },
    ],
    notes: ['Élise Aubert is allergic to shellfish.'],
  },
  {
    name: 'Marc Vidal',
    relationship: 'Brother-in-law',
    birthday: { month: 11, day: 2, year: 1985 },
    facts: [
      {
        content: 'Marc Vidal lives in Lyon with Élise.',
        subject: 'Marc Vidal',
        predicate: 'lives_in',
        object: 'Lyon',
        objectKind: 'place',
      },
      {
        content: 'Marc Vidal works at Rhône Analytics as a data engineer.',
        subject: 'Marc Vidal',
        predicate: 'works_at',
        object: 'Rhône Analytics',
        objectKind: 'organization',
        validFrom: '2021-09',
      },
    ],
    events: [{ content: 'Marc mentioned he is taking the autumn off to renovate.', daysAgo: 12 }],
    notes: [],
  },
  {
    name: 'Priya Raman',
    relationship: 'Colleague at Northwind',
    // Inside the default seven-day lead window, so the reminder strip renders.
    birthday: { month: now.getUTCMonth() + 1, day: now.getUTCDate(), year: 1991 },
    facts: [
      {
        content: 'Priya Raman works at Northwind, where she leads the platform team.',
        subject: 'Priya Raman',
        predicate: 'works_at',
        object: 'Northwind',
        objectKind: 'organization',
        validFrom: '2019-01',
      },
      {
        content: 'Priya Raman lives in Rotterdam.',
        subject: 'Priya Raman',
        predicate: 'lives_in',
        object: 'Rotterdam',
        objectKind: 'place',
      },
    ],
    events: [
      { content: 'Priya walked through the migration plan on the Thursday call.', daysAgo: 4 },
      { content: 'Priya asked whether the interview went ahead.', daysAgo: 20 },
    ],
    notes: ['Priya Raman prefers written summaries over meetings.'],
  },
  {
    name: 'Tomás Ferreira',
    relationship: 'Friend',
    // No year: the card must show the date and no age.
    birthday: { month: 6, day: 9 },
    facts: [
      {
        content: 'Tomás Ferreira and the owner met during the 2014 Lisbon type conference.',
        subject: 'Tomás Ferreira',
        predicate: 'met_during',
        object: '2014 Lisbon type conference',
        objectKind: 'event',
      },
      {
        content: 'Tomás Ferreira worked at Praça Studio between 2015 and 2022.',
        subject: 'Tomás Ferreira',
        predicate: 'worked_at',
        object: 'Praça Studio',
        objectKind: 'organization',
        validFrom: '2015',
        validUntil: '2022',
      },
    ],
    events: [{ content: 'Tomás is in town in October and suggested dinner.', daysAgo: 45 }],
    notes: [],
  },
  {
    // No graph edges at all: relationships, location and how-we-met must all
    // fall back to their empty states while the birthday still renders.
    name: 'Greta Lindqvist',
    relationship: 'Neighbour',
    birthday: { month: 12, day: 24, year: 1970 },
    facts: [],
    events: [],
    notes: ['Greta Lindqvist waters the plants when the flat is empty.'],
  },
  {
    // Nothing but a name — every section on the card must degrade cleanly.
    name: 'Sam Okonkwo',
    relationship: '',
    facts: [],
    events: [],
    notes: [],
  },
];

/** Content hashes are globally unique, so fixture rows carry their own namespace. */
function hash(content: string): string {
  return createHash('sha256').update(`${SOURCE}:${content}`).digest('hex');
}

async function purge(): Promise<number> {
  const rows = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.notes, SOURCE));
  const ids = rows.map((row) => row.id);
  // Relations and sources cascade from the memories they cite; entities are
  // removed explicitly because a contact reference is `set null`, not cascade.
  await db.delete(memories).where(eq(memories.source, SOURCE));
  const entityRows = await db
    .select({ id: knowledgeGraphEntities.id })
    .from(knowledgeGraphEntities)
    .where(eq(knowledgeGraphEntities.agentId, agent.id));
  const fixtureEntities = entityRows.map((row) => row.id);
  if (fixtureEntities.length > 0) {
    await db
      .delete(knowledgeGraphRelations)
      .where(inArray(knowledgeGraphRelations.subjectEntityId, fixtureEntities));
  }
  if (ids.length > 0) {
    await db.delete(occasions).where(inArray(occasions.contactId, ids));
    await db.delete(knowledgeGraphEntities).where(inArray(knowledgeGraphEntities.contactId, ids));
    await db.delete(contacts).where(inArray(contacts.id, ids));
  }
  // Fixture entities for places, employers and events have no contact link.
  await db
    .delete(knowledgeGraphEntities)
    .where(inArray(knowledgeGraphEntities.canonicalKey, nonPersonKeys()));
  return ids.length;
}

function nonPersonKeys(): string[] {
  const keys = new Set<string>();
  for (const person of PEOPLE) {
    for (const fact of person.facts) {
      if (fact.objectKind !== 'person') {
        keys.add(`${fact.objectKind}:${fact.object.toLocaleLowerCase()}`);
      }
    }
  }
  return [...keys, 'never-matches'];
}

const removed = await purge();
if (process.argv.includes('--purge')) {
  console.log(`Removed ${removed} demo contacts.`);
  process.exit(0);
}

/** Person nodes are keyed `contact:<uuid>`; everything else `<kind>:<label>`. */
const entityIds = new Map<string, string>();

async function entityFor(label: string, kind: Kind, contactId?: string): Promise<string> {
  const canonicalKey = contactId ? `contact:${contactId}` : `${kind}:${label.toLocaleLowerCase()}`;
  const existing = entityIds.get(canonicalKey);
  if (existing) return existing;
  const [row] = await db
    .insert(knowledgeGraphEntities)
    .values({ agentId: agent.id, canonicalKey, label, kind, contactId })
    .onConflictDoUpdate({
      target: [knowledgeGraphEntities.agentId, knowledgeGraphEntities.canonicalKey],
      set: { label, kind },
    })
    .returning({ id: knowledgeGraphEntities.id });
  const id = row?.id;
  if (!id) throw new Error(`Could not create graph entity for ${canonicalKey}`);
  entityIds.set(canonicalKey, id);
  return id;
}

const contactIds = new Map<string, string>();

// Pass one: contacts, so a person↔person edge can reference either end.
for (const person of PEOPLE) {
  const [row] = await db
    .insert(contacts)
    .values({
      name: person.name,
      relationship: person.relationship,
      trust: 'known',
      // The fixture tag lives in `notes` — there is no `source` column here.
      notes: SOURCE,
    })
    .returning({ id: contacts.id });
  if (!row) throw new Error(`Could not create contact ${person.name}`);
  contactIds.set(person.name, row.id);
  await entityFor(person.name, 'person', row.id);
}

// Léa is named only as the object of an edge, so she needs her own contact row
// for the relationship to link anywhere.
{
  const [row] = await db
    .insert(contacts)
    .values({ name: 'Léa Aubert', relationship: 'Niece', trust: 'known', notes: SOURCE })
    .returning({ id: contacts.id });
  if (row) {
    contactIds.set('Léa Aubert', row.id);
    await entityFor('Léa Aubert', 'person', row.id);
  }
}

for (const person of PEOPLE) {
  const contactId = contactIds.get(person.name);
  if (!contactId) continue;

  if (person.birthday) {
    await db
      .insert(occasions)
      .values({
        agentId: agent.id,
        contactId,
        kind: 'birthday',
        month: person.birthday.month,
        day: person.birthday.day,
        year: person.birthday.year ?? null,
        ownerConfirmed: true,
        source: SOURCE,
      })
      .onConflictDoNothing();
  }

  // Facts that back a graph edge. Each needs the full liveness set.
  for (const [index, fact] of person.facts.entries()) {
    const contentHash = hash(fact.content);
    const [memory] = await db
      .insert(memories)
      .values({
        agentId: agent.id,
        category: 'knowledge',
        kind: 'fact',
        content: fact.content,
        contentHash,
        embedding: EMBEDDING,
        importance: 3,
        confidence: '0.90',
        originTrust: 'owner',
        ownerConfirmed: true,
        subjectContactId: contactId,
        domain: 'relationships',
        source: SOURCE,
      })
      .onConflictDoNothing({ target: memories.contentHash })
      .returning({ id: memories.id });
    if (!memory) continue;

    await db
      .insert(knowledgeGraphSources)
      .values({
        memoryId: memory.id,
        contentHash,
        subjectContactId: contactId,
        status: 'ready',
        extractionVersion: GRAPH_EXTRACTION_VERSION,
      })
      .onConflictDoNothing();

    const subjectId = await entityFor(
      fact.subject,
      'person',
      contactIds.get(fact.subject) ?? undefined,
    );
    const objectId = await entityFor(
      fact.object,
      fact.objectKind,
      fact.objectKind === 'person' ? contactIds.get(fact.object) : undefined,
    );

    await db
      .insert(knowledgeGraphRelations)
      .values({
        agentId: agent.id,
        subjectEntityId: subjectId,
        predicate: fact.predicate,
        objectEntityId: objectId,
        sourceMemoryId: memory.id,
        evidenceQuote: fact.content,
        sourceFingerprint: `${SOURCE}:${fact.predicate}:${index}`,
        ordinal: index,
        confidence: '0.90',
        validFrom: fact.validFrom ?? null,
        validUntil: fact.validUntil ?? null,
        reviewStatus: 'confirmed',
        reviewedAt: now,
      })
      .onConflictDoNothing();
  }

  // Plain facts with no edge — these fill the "Saved facts" list.
  for (const note of person.notes) {
    await db
      .insert(memories)
      .values({
        agentId: agent.id,
        category: 'knowledge',
        kind: 'fact',
        content: note,
        contentHash: hash(note),
        embedding: EMBEDDING,
        importance: 2,
        confidence: '0.80',
        originTrust: 'owner',
        ownerConfirmed: true,
        subjectContactId: contactId,
        domain: 'relationships',
        source: SOURCE,
      })
      .onConflictDoNothing({ target: memories.contentHash });
  }

  // Experience rows: what happened, and what "last contact" is read from.
  for (const event of person.events) {
    const when = daysAgo(event.daysAgo);
    await db
      .insert(memories)
      .values({
        agentId: agent.id,
        category: 'experience',
        kind: 'episode',
        content: event.content,
        contentHash: hash(event.content),
        embedding: EMBEDDING,
        importance: 3,
        confidence: '0.90',
        originTrust: 'owner',
        subjectContactId: contactId,
        validFrom: when,
        createdAt: when,
        source: SOURCE,
        // Experience rows expire; keep the fixture visible for a while.
        expiresAt: new Date(now.getTime() + 90 * 86_400_000),
      })
      .onConflictDoNothing({ target: memories.contentHash });
  }
}

console.log(`Demo people ready (${PEOPLE.length + 1} contacts, agent ${agent.name}).`);
for (const [name, id] of contactIds) console.log(`  ${id}  ${name}`);
console.log(
  `\nBirthday inside its lead window: Priya Raman (${now.getUTCDate()}/${now.getUTCMonth() + 1}).`,
);
console.log(`Reference year for spans: ${year}.`);
process.exit(0);
