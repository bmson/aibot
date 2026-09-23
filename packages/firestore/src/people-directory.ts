import type { ProfileContact, Records } from '@assistant/persistence';
import { FieldPath, type Query } from '@google-cloud/firestore';
import { assertPrivacyErasureFenceUnchanged, readPrivacyErasureFence } from './privacy-erasure.js';
import { FirestoreProfilePeopleReadRepository } from './profile-people-read.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const PAGE_SIZE = 400;
const MAX_ROWS = 100_000;

async function byAgent<T extends { id: string; agentId: string }>(
  store: InstallationStore,
  collection: string,
  agentId: string,
): Promise<T[]> {
  const rows: T[] = [];
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  for (;;) {
    let query: Query = store
      .collection(collection)
      .where('agentId', '==', agentId)
      .orderBy(FieldPath.documentId())
      .limit(PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    for (const doc of page.docs) {
      const row = decodeRecord<T>(doc.data());
      if (row.agentId !== agentId || !row.id || documentKey(row.id) !== doc.id)
        throw new Error(`People directory has a malformed ${collection} record`);
      rows.push(row);
    }
    if (rows.length > MAX_ROWS) throw new Error('People directory scan exceeds its limit');
    if (page.size < PAGE_SIZE) return rows;
    cursor = page.docs.at(-1);
  }
}

export interface FirestorePersonDirectoryRow {
  contact: ProfileContact;
  factCount: number;
  birthday: Records['occasions'] | null;
  lastContactAt: Date | null;
  location: string | null;
}

const date = (value: unknown): value is Date =>
  value instanceof Date && Number.isFinite(value.getTime());
const nullableDate = (value: unknown): value is Date | null => value === null || date(value);
const nullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

function validateProjectionRows(
  memories: Records['memories'][],
  occasions: Records['occasions'][],
  entities: Records['knowledgeGraphEntities'][],
  relations: Records['knowledgeGraphRelations'][],
): void {
  if (
    memories.some(
      (row) =>
        !nullableString(row.subjectContactId) ||
        typeof row.category !== 'string' ||
        typeof row.quarantined !== 'boolean' ||
        !nullableDate(row.expiresAt) ||
        !date(row.createdAt) ||
        !nullableDate(row.validFrom) ||
        typeof row.contentHash !== 'string' ||
        (row.embedding !== null &&
          (!Array.isArray(row.embedding) ||
            row.embedding.some((value) => typeof value !== 'number' || !Number.isFinite(value)))),
    ) ||
    occasions.some(
      (row) =>
        typeof row.contactId !== 'string' ||
        typeof row.kind !== 'string' ||
        typeof row.quarantined !== 'boolean' ||
        !Number.isInteger(row.month) ||
        row.month < 1 ||
        row.month > 12 ||
        !Number.isInteger(row.day) ||
        row.day < 1 ||
        row.day > 31 ||
        (row.year !== null && !Number.isInteger(row.year)),
    ) ||
    entities.some(
      (row) =>
        !nullableString(row.contactId) ||
        typeof row.label !== 'string' ||
        !nullableString(row.preferredLabel),
    ) ||
    relations.some(
      (row) =>
        typeof row.subjectEntityId !== 'string' ||
        typeof row.objectEntityId !== 'string' ||
        typeof row.sourceMemoryId !== 'string' ||
        typeof row.predicate !== 'string' ||
        !nullableString(row.validUntil) ||
        typeof row.reviewStatus !== 'string' ||
        !nullableString(row.evidenceQuote),
    )
  )
    throw new Error('People directory contains a malformed projection record');
}

async function assertConfiguredOwner(store: InstallationStore, agentId: string): Promise<void> {
  const agents = await store.collection('agents').limit(2).get();
  const owner = agents.docs[0];
  if (
    !agentId ||
    agents.size !== 1 ||
    !owner ||
    owner.get('id') !== agentId ||
    owner.id !== documentKey(agentId)
  )
    throw new Error('People directory requires exactly one configured agent');
}

/** Complete contact directory; richer dossier data is not part of this read. */
export async function getFirestorePeopleDirectory(
  store: InstallationStore,
  configuredAgentId: string,
): Promise<ProfileContact[]> {
  await assertConfiguredOwner(store, configuredAgentId);
  const fence = await readPrivacyErasureFence(store, configuredAgentId);
  const contacts = await new FirestoreProfilePeopleReadRepository(
    store,
    configuredAgentId,
  ).listContacts();
  if (
    contacts.some(
      (contact) =>
        !contact.id ||
        typeof contact.name !== 'string' ||
        typeof contact.relationship !== 'string' ||
        typeof contact.trust !== 'string',
    )
  )
    throw new Error('People directory contains a malformed contact');
  await assertConfiguredOwner(store, configuredAgentId);
  await assertPrivacyErasureFenceUnchanged(store, configuredAgentId, fence);
  return contacts.filter((contact) => contact.trust !== 'owner');
}

/** One saved contact; SQL graph, events, and mutation controls are not available here. */
export async function getFirestorePersonDetail(
  store: InstallationStore,
  configuredAgentId: string,
  contactId: string,
): Promise<ProfileContact | null> {
  await assertConfiguredOwner(store, configuredAgentId);
  const fence = await readPrivacyErasureFence(store, configuredAgentId);
  const contact = await new FirestoreProfilePeopleReadRepository(
    store,
    configuredAgentId,
  ).getContact(contactId);
  if (
    contact &&
    (!contact.id ||
      typeof contact.name !== 'string' ||
      typeof contact.relationship !== 'string' ||
      typeof contact.trust !== 'string')
  )
    throw new Error('People detail contains a malformed contact');
  await assertConfiguredOwner(store, configuredAgentId);
  await assertPrivacyErasureFenceUnchanged(store, configuredAgentId, fence);
  return contact?.trust === 'owner' ? null : contact;
}

/** Mobile directory fields derived from the same owner-scoped Firestore records as SQL. */
export async function getFirestoreMobilePeopleDirectory(
  store: InstallationStore,
  configuredAgentId: string,
  now: Date,
  extractionVersion: number,
): Promise<FirestorePersonDirectoryRow[]> {
  const fence = await readPrivacyErasureFence(store, configuredAgentId);
  const contacts = (await getFirestorePeopleDirectory(store, configuredAgentId)).slice(0, 500);
  const contactIds = new Set(contacts.map((contact) => contact.id));
  const [memories, occasions, entities, relations] = await Promise.all([
    byAgent<Records['memories']>(store, 'memories', configuredAgentId),
    byAgent<Records['occasions']>(store, 'occasions', configuredAgentId),
    byAgent<Records['knowledgeGraphEntities']>(store, 'knowledgeGraphEntities', configuredAgentId),
    byAgent<Records['knowledgeGraphRelations']>(
      store,
      'knowledgeGraphRelations',
      configuredAgentId,
    ),
  ]);
  validateProjectionRows(memories, occasions, entities, relations);
  const active = (memory: Records['memories']) =>
    memory.quarantined === false &&
    (memory.expiresAt === null || (memory.expiresAt instanceof Date && memory.expiresAt > now));
  const factCounts = new Map<string, number>();
  const lastContacts = new Map<string, Date>();
  const memoryById = new Map(memories.map((memory) => [memory.id, memory]));
  for (const memory of memories) {
    const id = memory.subjectContactId;
    if (!id || !contactIds.has(id) || !active(memory)) continue;
    if (memory.category === 'knowledge') factCounts.set(id, (factCounts.get(id) ?? 0) + 1);
    if (memory.category === 'experience') {
      const occurredAt = memory.validFrom ?? memory.createdAt;
      if (!(occurredAt instanceof Date))
        throw new Error('People directory has an invalid event date');
      const previous = lastContacts.get(id);
      if (!previous || occurredAt > previous) lastContacts.set(id, occurredAt);
    }
  }
  const birthdays = new Map<string, Records['occasions']>();
  for (const occasion of occasions.sort(
    (a, b) => a.month - b.month || a.day - b.day || a.id.localeCompare(b.id),
  )) {
    if (
      occasion.kind === 'birthday' &&
      !occasion.quarantined &&
      contactIds.has(occasion.contactId) &&
      !birthdays.has(occasion.contactId)
    )
      birthdays.set(occasion.contactId, occasion);
  }
  const entityById = new Map(entities.map((entity) => [entity.id, entity]));
  const activeLocationRelations = relations.filter(
    (relation) =>
      relation.predicate === 'lives_in' &&
      relation.validUntil === null &&
      relation.reviewStatus !== 'rejected' &&
      relation.evidenceQuote != null &&
      contactIds.has(entityById.get(relation.subjectEntityId)?.contactId ?? ''),
  );
  const sourceIds = [
    ...new Set(activeLocationRelations.map((relation) => relation.sourceMemoryId)),
  ];
  const sourceIdByDocument = new Map(sourceIds.map((id) => [documentKey(id), id]));
  const sources = new Map<string, Records['knowledgeGraphSources']>();
  for (let offset = 0; offset < sourceIds.length; offset += 200) {
    const docs = await store.db.getAll(
      ...sourceIds.slice(offset, offset + 200).map((id) => store.doc('knowledgeGraphSources', id)),
    );
    for (const doc of docs) {
      if (!doc.exists) continue;
      const source = decodeRecord<Records['knowledgeGraphSources']>(doc.data());
      if (
        source.memoryId !== sourceIdByDocument.get(doc.id) ||
        typeof source.status !== 'string' ||
        typeof source.contentHash !== 'string' ||
        !Number.isSafeInteger(source.extractionVersion) ||
        source.extractionVersion < 0
      )
        throw new Error('People directory has a malformed graph source');
      sources.set(source.memoryId, source);
    }
  }
  const locations = new Map<string, string>();
  for (const relation of activeLocationRelations.sort((a, b) => a.id.localeCompare(b.id))) {
    const subject = entityById.get(relation.subjectEntityId);
    const object = entityById.get(relation.objectEntityId);
    const memory = memoryById.get(relation.sourceMemoryId);
    const source = sources.get(relation.sourceMemoryId);
    if (
      !subject?.contactId ||
      !object ||
      !memory ||
      !source ||
      memory.category !== 'knowledge' ||
      !active(memory) ||
      !memory.embedding ||
      source.status !== 'ready' ||
      source.contentHash !== memory.contentHash ||
      source.extractionVersion < extractionVersion ||
      locations.has(subject.contactId)
    )
      continue;
    locations.set(subject.contactId, object.preferredLabel ?? object.label);
  }
  await assertConfiguredOwner(store, configuredAgentId);
  await assertPrivacyErasureFenceUnchanged(store, configuredAgentId, fence);
  return contacts.map((contact) => ({
    contact,
    factCount: factCounts.get(contact.id) ?? 0,
    birthday: birthdays.get(contact.id) ?? null,
    lastContactAt: lastContacts.get(contact.id) ?? null,
    location: locations.get(contact.id) ?? null,
  }));
}
