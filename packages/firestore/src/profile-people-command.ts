import { randomUUID } from 'node:crypto';
import type { ProfilePeopleCommandRepository, Records } from '@assistant/persistence';
import type { DocumentSnapshot, Transaction } from '@google-cloud/firestore';
import { privacyErasureIsActive } from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

const CONTACT_SCAN_LIMIT = 500;
type Contact = Records['contacts'];

async function assertWritableOwner(
  tx: Transaction,
  store: InstallationStore,
  agentId: string,
): Promise<void> {
  const owners = await tx.get(store.collection('agents').limit(2));
  const owner = owners.docs[0];
  if (
    owners.size !== 1 ||
    !owner ||
    owner.get('id') !== agentId ||
    owner.id !== documentKey(agentId)
  )
    throw new Error('Profile mutation requires exactly one configured owner');
  const erasure = await tx.get(store.doc('privacyErasureJobs', agentId));
  if (
    erasure.exists &&
    (erasure.get('agentId') !== agentId || privacyErasureIsActive(erasure.get('status')))
  )
    throw new Error('Privacy erasure is in progress');
}

function readContact(snapshot: DocumentSnapshot): Contact {
  const row = decodeRecord<Contact>(snapshot.data());
  if (
    typeof row.id !== 'string' ||
    documentKey(row.id) !== snapshot.id ||
    typeof row.name !== 'string' ||
    typeof row.relationship !== 'string' ||
    typeof row.trust !== 'string' ||
    !Array.isArray(row.aliases) ||
    !Array.isArray(row.emails) ||
    !Array.isArray(row.phones) ||
    typeof row.notes !== 'string'
  )
    throw new Error('Person record is malformed');
  return row;
}

/** Owner-scoped Firestore writes for non-destructive person profile edits. */
export class FirestoreProfilePeopleCommandRepository implements ProfilePeopleCommandRepository {
  readonly kind = 'profile-people-command-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
  ) {}

  async create(input: { name: string; relationship: string; aliases: string[] }): Promise<string> {
    const id = randomUUID();
    const ref = this.store.doc('contacts', id);
    const rows = this.store.collection('contacts').limit(CONTACT_SCAN_LIMIT + 1);
    await this.store.db.runTransaction(async (tx) => {
      await assertWritableOwner(tx, this.store, this.configuredAgentId);
      const existing = await tx.get(rows);
      if (existing.size > CONTACT_SCAN_LIMIT)
        throw new Error('Contact directory is too large to update safely');
      const contacts = existing.docs.map((snapshot) => {
        const ownerId = snapshot.get('agentId');
        if (ownerId !== undefined && ownerId !== this.configuredAgentId) return null;
        return readContact(snapshot);
      });
      if (contacts.some((row) => row?.name.toLocaleLowerCase() === input.name.toLocaleLowerCase()))
        throw new Error('A person with that name already exists.');
      const now = this.store.now();
      const contact: Contact & { agentId: string } = {
        id,
        agentId: this.configuredAgentId,
        name: input.name,
        relationship: input.relationship,
        aliases: input.aliases,
        emails: [],
        phones: [],
        notes: '',
        trust: 'known',
        createdAt: now,
        updatedAt: now,
      };
      tx.create(ref, encodeRecord(contact));
    });
    return id;
  }

  async updateRelationship(contactId: string, relationship: string): Promise<void> {
    const ref = this.store.doc('contacts', contactId);
    await this.store.db.runTransaction(async (tx) => {
      await assertWritableOwner(tx, this.store, this.configuredAgentId);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return;
      const contact = readContact(snapshot);
      const ownerId = snapshot.get('agentId');
      if (ownerId !== undefined && ownerId !== this.configuredAgentId)
        throw new Error('Person not found.');
      tx.update(ref, {
        relationship,
        ...(relationship && contact.trust === 'unknown' ? { trust: 'known' } : {}),
        updatedAt: this.store.now(),
      });
    });
  }

  async updateIdentity(contactId: string, name: string, aliases: string[]): Promise<void> {
    const ref = this.store.doc('contacts', contactId);
    const contactsQuery = this.store.collection('contacts').limit(CONTACT_SCAN_LIMIT + 1);
    await this.store.db.runTransaction(async (tx) => {
      await assertWritableOwner(tx, this.store, this.configuredAgentId);
      const [snapshot, existing] = await Promise.all([tx.get(ref), tx.get(contactsQuery)]);
      if (!snapshot.exists) throw new Error('Person not found or cannot be renamed.');
      const contact = readContact(snapshot);
      const ownerId = snapshot.get('agentId');
      if (
        (ownerId !== undefined && ownerId !== this.configuredAgentId) ||
        contact.trust === 'owner'
      )
        throw new Error('Person not found or cannot be renamed.');
      if (existing.size > CONTACT_SCAN_LIMIT)
        throw new Error('Contact directory is too large to update safely');
      const duplicate = existing.docs.some((candidate) => {
        if (candidate.id === snapshot.id) return false;
        const ownerId = candidate.get('agentId');
        if (ownerId !== undefined && ownerId !== this.configuredAgentId) return false;
        const row = readContact(candidate);
        return row.name.toLocaleLowerCase() === name.toLocaleLowerCase();
      });
      if (duplicate) throw new Error('A person with that name already exists.');
      const renamed = contact.name.toLocaleLowerCase() !== name.toLocaleLowerCase();
      const normalizedAliases = new Map<string, string>();
      for (const alias of [...aliases, ...(renamed ? [contact.name] : [])]) {
        const key = alias.toLocaleLowerCase();
        if (key !== name.toLocaleLowerCase() && !normalizedAliases.has(key))
          normalizedAliases.set(key, alias);
      }
      if (normalizedAliases.size > 20) throw new Error('A person can have at most 20 aliases.');
      tx.update(ref, {
        name,
        aliases: [...normalizedAliases.values()],
        updatedAt: this.store.now(),
      });
    });
  }
}
