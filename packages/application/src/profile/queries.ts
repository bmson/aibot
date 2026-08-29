import { getAgent } from '@assistant/core/chat';
import {
  CARD_AUTO_FACTS_PER_DOMAIN,
  CARD_AUTO_MIN_IMPORTANCE,
} from '@assistant/core/memory/consolidation';
import { getMemoryHealth, type MemoryHealth } from '@assistant/core/memory/health';
import { GRAPH_EXTRACTION_VERSION } from '@assistant/core/memory/knowledge-graph';
import { detectOccasionInText, listOccasionsForContact } from '@assistant/core/memory/occasions';
import { type VoiceSampleStats, voiceSampleStats } from '@assistant/core/memory/voice-ingest';
import {
  contacts,
  type Db,
  findDuplicateContactSuggestions,
  importSources,
  knowledgeGraphSources,
  memories,
  ownerCard,
  tasks,
  voiceProfile,
} from '@assistant/db';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNotNull,
  isNull,
  like,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import {
  activeKnowledgeGraphConnectionCountForMemory,
  activeKnowledgeGraphRelationExistsForMemory,
} from '../knowledge-graph.js';

export interface MemorySnapshot {
  id: string;
  content: string;
  kind: string;
  domain: string | null;
  confidence: string;
  importance: number;
  ownerConfirmed: boolean;
  pinned: boolean;
  lastConsolidatedAt: Date | null;
  originTrust: string;
  sourceTaskId: string | null;
  createdAt: Date;
  validFrom: Date | null;
  validUntil: Date | null;
}

export interface ContactSnapshot {
  id: string;
  name: string;
  aliases: string[];
  relationship: string;
  trust: string;
}

export interface ProfileOverview {
  owner?: ContactSnapshot;
  people: Array<{ contact: ContactSnapshot; factCount: number }>;
  ownerFacts: MemorySnapshot[];
  quarantined: MemorySnapshot[];
  card: { content: string; compiledAt: Date } | null;
  cardFactIds: string[];
  voiceStats: VoiceSampleStats;
  /** The distilled voice the rewriter imitates — owner-editable on Profile. */
  voiceProfile: { description: string; dos: string[]; donts: string[]; signature: string };
  voiceImports: Array<{
    source: string;
    status: string;
    itemsTotal: number | null;
    itemsProcessed: number;
    memoriesSaved: number;
    taskId: string | null;
    error: string | null;
  }>;
  memoryHealth: MemoryHealth;
  latestOrganizer: {
    id: string;
    status: string;
    progress: string;
    updatedAt: Date;
  } | null;
}

const PROFILE_CONTACT_LIMIT = 500;
const PROFILE_FACT_LIMIT = 250;
const QUARANTINE_LIMIT = 100;
const VOICE_IMPORT_LIMIT = 5;

/** Load the complete memory overview without exposing persistence to Next.js. */
export async function getProfileOverview(db: Db): Promise<ProfileOverview> {
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
    [voice],
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
    db.select().from(voiceProfile).where(eq(voiceProfile.id, 1)).limit(1),
  ]);

  const owner = allContacts.find((contact) => contact.trust === 'owner');
  const contactIds = allContacts.map((contact) => contact.id);
  const [ownerFacts, factCountRows] = await Promise.all([
    owner
      ? db
          .select()
          .from(memories)
          .where(and(active, eq(memories.subjectContactId, owner.id)))
          .orderBy(desc(memories.pinned), desc(memories.importance), desc(memories.confidence))
          .limit(PROFILE_FACT_LIMIT)
      : Promise.resolve([]),
    contactIds.length > 0
      ? db
          .select({ contactId: memories.subjectContactId, value: count() })
          .from(memories)
          .where(and(active, inArray(memories.subjectContactId, contactIds)))
          .groupBy(memories.subjectContactId)
      : Promise.resolve([]),
  ]);
  const factCounts = new Map(factCountRows.map((row) => [row.contactId ?? '', Number(row.value)]));

  const cardFactIds = new Set<string>();
  for (const domain of [
    'identity',
    'work',
    'home',
    'relationships',
    'preferences',
    'health',
    'other',
  ]) {
    const facts = ownerFacts.filter((memory) => (memory.domain ?? 'other') === domain);
    for (const memory of facts.filter((fact) => fact.pinned)) cardFactIds.add(memory.id);
    for (const memory of facts
      .filter((fact) => !fact.pinned && fact.importance >= CARD_AUTO_MIN_IMPORTANCE)
      .slice(0, CARD_AUTO_FACTS_PER_DOMAIN)) {
      cardFactIds.add(memory.id);
    }
  }

  return {
    ...(owner ? { owner } : {}),
    people: allContacts
      .filter((contact) => contact.trust !== 'owner')
      .map((contact) => ({ contact, factCount: factCounts.get(contact.id) ?? 0 })),
    ownerFacts,
    quarantined,
    card: card ? { content: card.content, compiledAt: card.compiledAt } : null,
    cardFactIds: [...cardFactIds],
    voiceStats,
    voiceProfile: {
      description: voice?.description ?? '',
      dos: Array.isArray(voice?.dos)
        ? voice.dos.filter((d): d is string => typeof d === 'string')
        : [],
      donts: Array.isArray(voice?.donts)
        ? voice.donts.filter((d): d is string => typeof d === 'string')
        : [],
      signature: voice?.signature ?? '',
    },
    voiceImports: voiceImports.map((row) => ({
      source: row.source,
      status: row.status,
      itemsTotal: row.itemsTotal,
      itemsProcessed: row.itemsProcessed,
      memoriesSaved: row.memoriesSaved,
      taskId: row.taskId,
      error: row.error,
    })),
    memoryHealth,
    latestOrganizer: latestOrganizerRows[0] ?? null,
  };
}

export type MemoryState = 'in-use' | 'review';
export type MemoryFilter = 'all' | 'verified' | 'untidied';

export interface MemoryLibrary {
  rows: Array<{
    memory: MemorySnapshot;
    subjectId: string | null;
    subjectLabel: string | null;
    subjectTrust: string | null;
    /** Direct recall-eligible graph edges supported by this exact memory. */
    connectionCount: number;
    /** Explains why a source has no active graph edge without surfacing stale projections. */
    projectionStatus: MemoryProjectionStatus;
  }>;
  total: number;
  page: number;
  totalPages: number;
}

export type MemoryProjectionStatus = 'connected' | 'mapping' | 'needs_attention' | 'no_connections';

export interface MemoryLibraryFilters {
  subjects: Array<{ id: string; label: string; trust: string }>;
  sources: string[];
}

export async function listMemoryLibraryFilters(db: Db): Promise<MemoryLibraryFilters> {
  const agent = await getAgent(db);
  const [subjectRows, sourceRows] = await Promise.all([
    db
      .select({ id: contacts.id, label: contacts.name, trust: contacts.trust })
      .from(memories)
      .innerJoin(contacts, eq(memories.subjectContactId, contacts.id))
      .where(and(eq(memories.agentId, agent.id), eq(memories.category, 'knowledge')))
      .groupBy(contacts.id, contacts.name, contacts.trust)
      .orderBy(asc(contacts.name)),
    db
      .select({ source: memories.source })
      .from(memories)
      .where(
        and(
          eq(memories.agentId, agent.id),
          eq(memories.category, 'knowledge'),
          isNotNull(memories.source),
        ),
      )
      .groupBy(memories.source)
      .orderBy(asc(memories.source)),
  ]);
  return {
    subjects: subjectRows,
    sources: sourceRows.flatMap((row) => (row.source ? [row.source] : [])),
  };
}

export async function listMemoryLibrary(
  db: Db,
  input: {
    state: MemoryState;
    filter: MemoryFilter;
    query: string;
    page: number;
    pageSize?: number;
    subjectId?: string;
    domain?: string;
    source?: string;
    ageDays?: number;
    connectivity?: 'all' | 'connected' | 'unconnected';
  },
): Promise<MemoryLibrary> {
  const agent = await getAgent(db);
  const pageSize = input.pageSize ?? 60;
  const activeConnectionExists = activeKnowledgeGraphRelationExistsForMemory(agent.id, memories.id);
  const activeConnectionCount = activeKnowledgeGraphConnectionCountForMemory(agent.id, memories.id);
  const unexpired = or(isNull(memories.expiresAt), gt(memories.expiresAt, sql`now()`));
  const stateCondition: SQL | undefined =
    input.state === 'review'
      ? eq(memories.quarantined, true)
      : input.filter === 'verified'
        ? and(eq(memories.quarantined, false), eq(memories.ownerConfirmed, true))
        : input.filter === 'untidied'
          ? and(eq(memories.quarantined, false), isNull(memories.lastConsolidatedAt))
          : eq(memories.quarantined, false);
  const filters = and(
    eq(memories.agentId, agent.id),
    eq(memories.category, 'knowledge'),
    unexpired,
    stateCondition,
    input.query
      ? ilike(memories.content, `%${input.query.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`)
      : undefined,
    input.subjectId ? eq(memories.subjectContactId, input.subjectId) : undefined,
    input.domain ? eq(memories.domain, input.domain) : undefined,
    input.source ? eq(memories.source, input.source) : undefined,
    input.ageDays
      ? gt(memories.createdAt, sql`now() - (${input.ageDays} * interval '1 day')`)
      : undefined,
    input.connectivity === 'connected'
      ? activeConnectionExists
      : input.connectivity === 'unconnected'
        ? sql<boolean>`NOT ${activeConnectionExists}`
        : undefined,
  );
  const [totalRow] = await db.select({ value: count() }).from(memories).where(filters);
  const total = Number(totalRow?.value ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(input.page, totalPages);
  const rows = await db
    .select({
      memory: memories,
      subjectId: contacts.id,
      subjectLabel: contacts.name,
      subjectTrust: contacts.trust,
      connectionCount: activeConnectionCount,
      projectionStatus: sql<MemoryProjectionStatus>`CASE
        WHEN ${activeConnectionExists} THEN 'connected'
        WHEN ${knowledgeGraphSources.status} IN ('failed', 'quarantined') THEN 'needs_attention'
        WHEN ${knowledgeGraphSources.memoryId} IS NULL
          OR ${knowledgeGraphSources.status} = 'pending'
          OR ${knowledgeGraphSources.contentHash} <> ${memories.contentHash}
          OR ${knowledgeGraphSources.extractionVersion} < ${GRAPH_EXTRACTION_VERSION}
          THEN 'mapping'
        ELSE 'no_connections'
      END`,
    })
    .from(memories)
    .leftJoin(contacts, eq(memories.subjectContactId, contacts.id))
    .leftJoin(knowledgeGraphSources, eq(knowledgeGraphSources.memoryId, memories.id))
    .where(filters)
    .orderBy(
      desc(memories.pinned),
      desc(memories.ownerConfirmed),
      desc(memories.importance),
      desc(memories.createdAt),
    )
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return {
    rows: rows.map((row) => ({
      ...row,
      connectionCount: Number(row.connectionCount ?? 0),
      projectionStatus: row.projectionStatus as MemoryProjectionStatus,
    })),
    total,
    page,
    totalPages,
  };
}

export interface PersonProfile {
  contact: ContactSnapshot;
  facts: MemorySnapshot[];
  totalFacts: number;
  occasions: Array<{
    id: string;
    kind: string;
    label: string;
    month: number;
    day: number;
    year: number | null;
    notes: string;
    quarantined: boolean;
  }>;
  occasionSuggestions: Array<{ kind: 'birthday' | 'anniversary'; month: number; day: number }>;
  mergeOptions: Array<{ id: string; label: string }>;
  duplicate?: { targetId: string; reason: string };
}

export async function getPersonProfile(
  db: Db,
  contactId: string,
  factLimit = 250,
): Promise<PersonProfile | null> {
  const [contact] = await db.select().from(contacts).where(eq(contacts.id, contactId)).limit(1);
  if (!contact || contact.trust === 'owner') return null;
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
      .limit(factLimit),
    db
      .select({ value: count() })
      .from(memories)
      .where(and(active, eq(memories.subjectContactId, contact.id))),
    db.select().from(contacts).orderBy(contacts.name).limit(500),
    listOccasionsForContact(db, contact.id),
  ]);
  const existingDates = new Set(
    occasionRows.map((occasion) => `${occasion.month}-${occasion.day}`),
  );
  const suggestionSeen = new Set<string>();
  const occasionSuggestions: PersonProfile['occasionSuggestions'] = [];
  for (const fact of facts) {
    const detected = detectOccasionInText(fact.content);
    if (!detected) continue;
    const key = `${detected.month}-${detected.day}`;
    if (existingDates.has(key) || suggestionSeen.has(key)) continue;
    suggestionSeen.add(key);
    occasionSuggestions.push(detected);
  }
  const duplicate = findDuplicateContactSuggestions(allContacts).find(
    (suggestion) => suggestion.contactId === contact.id,
  );
  return {
    contact,
    facts,
    totalFacts: Number(factCount?.value ?? 0),
    occasions: occasionRows.map((occasion) => ({
      id: occasion.id,
      kind: occasion.kind,
      label: occasion.label,
      month: occasion.month,
      day: occasion.day,
      year: occasion.year,
      notes: occasion.notes,
      quarantined: occasion.quarantined,
    })),
    occasionSuggestions,
    mergeOptions: allContacts
      .filter((person) => person.id !== contact.id)
      .map((person) => ({
        id: person.id,
        label: person.relationship ? `${person.name} (${person.relationship})` : person.name,
      })),
    ...(duplicate ? { duplicate: { targetId: duplicate.targetId, reason: duplicate.reason } } : {}),
  };
}
