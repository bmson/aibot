import { createHash, randomUUID } from 'node:crypto';
import type { ContactLookupRepository, ContactLookupRow, Records } from '@assistant/persistence';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

/** Contacts are read whole; an installation past this bound fails instead of matching a subset. */
const CONTACT_SCAN_LIMIT = 5000;
const ASSISTANT_ALIASES = new Set(['assistant', 'ai bot', 'b bot', 'the assistant', 'bot']);

function namePrefixMatch(left: string, right: string): boolean {
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  return shorter.length >= 3 && (shorter === longer || longer.startsWith(`${shorter} `));
}

async function ownedContacts(
  store: InstallationStore,
  agentId: string,
): Promise<Records['contacts'][]> {
  const page = await store
    .collection('contacts')
    .limit(CONTACT_SCAN_LIMIT + 1)
    .get();
  if (page.size > CONTACT_SCAN_LIMIT) throw new Error('Firestore contact scan exceeded bound');
  return page.docs.flatMap((doc) => {
    const row = decodeRecord<Records['contacts'] & { agentId?: unknown }>(doc.data());
    // Contacts are installation-scoped; a record tagged for another owner is never matched.
    if (
      typeof row.id !== 'string' ||
      documentKey(row.id) !== doc.id ||
      typeof row.name !== 'string' ||
      (row.agentId !== undefined && row.agentId !== agentId)
    )
      return [];
    return [row];
  });
}

/**
 * Resolve who a fact or occasion is about, like memory.save does: "owner" or
 * the owner's name is the owner contact, another name prefix-matches a saved
 * contact, and a new name becomes an unknown-trust contact reserved by name so
 * concurrent saves share it. Assistant aliases resolve to no one.
 */
export async function resolveFirestoreSubjectContact(
  store: InstallationStore,
  agentId: string,
  subject: string,
  relationship?: string,
): Promise<string | null> {
  const name = subject.trim();
  if (!name || ASSISTANT_ALIASES.has(name.toLowerCase())) return null;
  const rows = await ownedContacts(store, agentId);
  const owner = rows.find((row) => row.trust === 'owner');
  const lower = name.toLowerCase();
  const ownerMatch = owner
    ? [owner.name, ...(owner.aliases ?? [])].find((candidate) =>
        namePrefixMatch(lower, candidate.toLowerCase()),
      )
    : undefined;
  if (lower === 'owner' || ownerMatch) return owner?.id ?? null;
  const match = rows
    .filter((row) => row.trust !== 'owner')
    .find((row) =>
      [row.name, ...(row.aliases ?? [])].some((candidate) =>
        namePrefixMatch(lower, candidate.toLowerCase()),
      ),
    );
  if (match) return match.id;

  const key = createHash('sha256').update(lower).digest('hex');
  const keyRef = store.doc('contactNames', key);
  return store.db.runTransaction(async (tx) => {
    const existing = await tx.get(keyRef);
    if (existing.exists) return String(existing.get('contactId'));
    const now = store.now();
    const id = randomUUID();
    const contact: Records['contacts'] = {
      id,
      name,
      createdAt: now,
      updatedAt: now,
      trust: 'unknown',
      aliases: [],
      emails: [],
      phones: [],
      relationship: relationship?.trim() ?? '',
      notes: '',
    };
    tx.create(store.doc('contacts', id), encodeRecord(contact));
    tx.create(keyRef, { contactId: id, createdAt: now });
    return id;
  });
}

/** Word-boundary name and alias lookup over saved contacts, for outbound addressing. */
export class FirestoreContactLookupRepository implements ContactLookupRepository {
  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
  ) {}

  async findByName(input: { agentId: string; query: string }): Promise<ContactLookupRow[]> {
    if (input.agentId !== this.configuredAgentId)
      throw new Error('Contact lookup is outside the configured Firestore agent');
    const lower = input.query.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
    if (lower.length < 2) return [];
    const rows = await ownedContacts(this.store, input.agentId);
    return rows
      .filter((contact) =>
        [contact.name, ...(contact.aliases ?? [])].some((candidate) =>
          namePrefixMatch(lower, candidate.toLocaleLowerCase()),
        ),
      )
      .map((contact) => ({
        name: contact.name,
        emails: Array.isArray(contact.emails)
          ? contact.emails.filter((value): value is string => typeof value === 'string')
          : [],
        phones: Array.isArray(contact.phones)
          ? contact.phones.filter((value): value is string => typeof value === 'string')
          : [],
        relationship: typeof contact.relationship === 'string' ? contact.relationship : '',
      }));
  }
}
