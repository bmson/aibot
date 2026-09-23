import { createHash } from 'node:crypto';
import type {
  ProfileOccasionCommandInput,
  ProfileOccasionCommandRepository,
  Records,
} from '@assistant/persistence';
import type { DocumentSnapshot, Transaction } from '@google-cloud/firestore';
import { privacyErasureIsActive } from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

type Occasion = Records['occasions'];
const MAX_CONTACT_OCCASIONS = 100;

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

function occasionId(
  agentId: string,
  input: Parameters<ProfileOccasionCommandRepository['create']>[0],
) {
  const key = [agentId, input.contactId, input.kind, input.month, input.day].join('\u0000');
  const bytes = createHash('sha256').update(key).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function validExisting(
  snapshot: DocumentSnapshot,
  agentId: string,
  contactId: string,
  kind: string,
  month: number,
  day: number,
): Occasion {
  const row = decodeRecord<Occasion>(snapshot.data());
  if (
    !row.id ||
    documentKey(row.id) !== snapshot.id ||
    row.agentId !== agentId ||
    row.contactId !== contactId ||
    row.kind !== kind ||
    row.month !== month ||
    row.day !== day ||
    typeof row.notes !== 'string' ||
    (row.year !== null && !Number.isInteger(row.year))
  )
    throw new Error('Existing occasion record is malformed');
  return row;
}

/** Transactional Firestore writer for owner-entered occasions. */
export class FirestoreProfileOccasionCommandRepository implements ProfileOccasionCommandRepository {
  readonly kind = 'profile-occasion-command-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
  ) {}

  async create(input: Parameters<ProfileOccasionCommandRepository['create']>[0]): Promise<void> {
    const id = occasionId(this.configuredAgentId, input);
    const ownerQuery = this.store.collection('agents').limit(2);
    const contactRef = this.store.doc('contacts', input.contactId);
    const erasureRef = this.store.doc('privacyErasureJobs', this.configuredAgentId);
    const occasionRef = this.store.doc('occasions', id);
    const contactOccasions = this.store
      .collection('occasions')
      .where('agentId', '==', this.configuredAgentId)
      .where('contactId', '==', input.contactId)
      .limit(MAX_CONTACT_OCCASIONS + 1);

    await this.store.db.runTransaction(async (tx) => {
      const owners = await tx.get(ownerQuery);
      const owner = owners.docs[0];
      if (
        owners.size !== 1 ||
        !owner ||
        owner.get('id') !== this.configuredAgentId ||
        owner.id !== documentKey(this.configuredAgentId)
      )
        throw new Error('Occasion creation requires exactly one configured owner');
      const [contact, erasure, keyedOccasion, contactOccasionPage] = await Promise.all([
        tx.get(contactRef),
        tx.get(erasureRef),
        tx.get(occasionRef),
        tx.get(contactOccasions),
      ]);
      if (!contact?.exists) throw new Error('Person not found.');
      const person = decodeRecord<Records['contacts']>(contact.data());
      if (person.id !== input.contactId || documentKey(person.id) !== contact.id)
        throw new Error('Person record is malformed');
      const contactAgentId = contact.get('agentId');
      if (contactAgentId !== undefined && contactAgentId !== this.configuredAgentId)
        throw new Error('Person not found.');

      if (
        erasure?.exists &&
        (erasure.get('agentId') !== this.configuredAgentId ||
          privacyErasureIsActive(erasure.get('status')))
      )
        throw new Error('Privacy erasure is in progress');

      if (contactOccasionPage.size > MAX_CONTACT_OCCASIONS)
        throw new Error('Person has too many occasions to update safely.');

      const matches = contactOccasionPage.docs.filter((snapshot) => {
        const row = decodeRecord<Partial<Occasion>>(snapshot.data());
        return row.kind === input.kind && row.month === input.month && row.day === input.day;
      });
      if (keyedOccasion?.exists && !matches.some((snapshot) => snapshot.id === keyedOccasion.id))
        throw new Error('Existing occasion record is malformed');
      if (matches.length > 1) throw new Error('Matching occasion records are ambiguous');

      const now = this.store.now();
      const existing = matches[0];
      if (existing) {
        const row = validExisting(
          existing,
          this.configuredAgentId,
          input.contactId,
          input.kind,
          input.month,
          input.day,
        );
        const notes =
          !input.notes || row.notes.includes(input.notes)
            ? row.notes
            : row.notes
              ? `${row.notes}; ${input.notes}`
              : input.notes;
        tx.update(existing.ref, {
          year: row.year ?? input.year,
          notes,
          updatedAt: now,
        });
        return;
      }

      const row: Occasion = {
        id,
        agentId: this.configuredAgentId,
        contactId: input.contactId,
        kind: input.kind,
        label: input.label,
        month: input.month,
        day: input.day,
        year: input.year,
        recurrence: 'annual',
        leadDays: input.leadDays,
        notes: input.notes,
        originTrust: 'owner',
        quarantined: false,
        ownerConfirmed: true,
        source: 'profile',
        createdAt: now,
        updatedAt: now,
      };
      tx.create(occasionRef, encodeRecord(row));
    });
  }

  async update(
    occasionId: string,
    input: Omit<ProfileOccasionCommandInput, 'contactId'>,
    expectedContactId?: string,
  ): Promise<boolean> {
    const occasionRef = this.store.doc('occasions', occasionId);
    const rowQuery = this.store
      .collection('occasions')
      .where('agentId', '==', this.configuredAgentId);
    return this.store.db.runTransaction(async (tx) => {
      await assertWritableOwner(tx, this.store, this.configuredAgentId);
      const [snapshot, page] = await Promise.all([
        tx.get(occasionRef),
        tx.get(rowQuery.limit(500)),
      ]);
      if (!snapshot.exists || snapshot.get('agentId') !== this.configuredAgentId) return false;
      const old = validExisting(
        snapshot,
        this.configuredAgentId,
        snapshot.get('contactId'),
        snapshot.get('kind'),
        snapshot.get('month'),
        snapshot.get('day'),
      );
      const contact = await tx.get(this.store.doc('contacts', old.contactId));
      if (!contact.exists) throw new Error('Person not found.');
      const person = decodeRecord<Records['contacts']>(contact.data());
      const contactAgentId = contact.get('agentId');
      if (
        (expectedContactId !== undefined && expectedContactId !== old.contactId) ||
        person.id !== old.contactId ||
        documentKey(person.id) !== contact.id ||
        (contactAgentId !== undefined && contactAgentId !== this.configuredAgentId)
      )
        throw new Error('Person not found.');
      if (page.size >= 500) throw new Error('Occasion update scan exceeds its safe limit');
      const duplicate = page.docs.some((doc) => {
        if (doc.id === snapshot.id) return false;
        const row = decodeRecord<Partial<Occasion>>(doc.data());
        return (
          row.agentId === this.configuredAgentId &&
          row.contactId === old.contactId &&
          row.kind === input.kind &&
          row.month === input.month &&
          row.day === input.day
        );
      });
      if (duplicate) throw new Error('Matching occasion records are ambiguous');
      tx.update(occasionRef, {
        kind: input.kind,
        label: input.label,
        month: input.month,
        day: input.day,
        year: input.year,
        leadDays: input.leadDays,
        notes: input.notes,
        originTrust: 'owner',
        ownerConfirmed: true,
        quarantined: false,
        updatedAt: this.store.now(),
      });
      return true;
    });
  }

  async forget(occasionId: string): Promise<void> {
    const ref = this.store.doc('occasions', occasionId);
    await this.store.db.runTransaction(async (tx) => {
      await assertWritableOwner(tx, this.store, this.configuredAgentId);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists || snapshot.get('agentId') !== this.configuredAgentId) return;
      const row = decodeRecord<Partial<Occasion>>(snapshot.data());
      if (row.id !== occasionId || documentKey(row.id) !== snapshot.id)
        throw new Error('Occasion record is malformed');
      tx.delete(ref);
    });
  }

  async review(occasionId: string, verdict: 'approve' | 'reject'): Promise<void> {
    const ref = this.store.doc('occasions', occasionId);
    await this.store.db.runTransaction(async (tx) => {
      await assertWritableOwner(tx, this.store, this.configuredAgentId);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists || snapshot.get('agentId') !== this.configuredAgentId) return;
      const row = decodeRecord<Partial<Occasion>>(snapshot.data());
      if (row.id !== occasionId || documentKey(row.id) !== snapshot.id)
        throw new Error('Occasion record is malformed');
      if (verdict === 'reject') tx.delete(ref);
      else
        tx.update(ref, {
          quarantined: false,
          ownerConfirmed: true,
          updatedAt: this.store.now(),
        });
    });
  }
}
