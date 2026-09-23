import type {
  ProfileContact,
  ProfileFact,
  ProfileOccasion,
  ProfilePeopleReadRepository,
} from '@assistant/persistence';
import { FieldPath, type Query, type QueryDocumentSnapshot } from '@google-cloud/firestore';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const PAGE_SIZE = 200;

async function collect<T extends { id: string }>(query: Query): Promise<T[]> {
  const rows: T[] = [];
  let cursor: QueryDocumentSnapshot | undefined;
  for (;;) {
    let pageQuery = query.orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) pageQuery = pageQuery.startAfter(cursor);
    const page = await pageQuery.get();
    for (const doc of page.docs) {
      const row = decodeRecord<Partial<T>>(doc.data());
      if (typeof row.id === 'string' && documentKey(row.id) === doc.id) rows.push(row as T);
    }
    if (page.size < PAGE_SIZE) return rows;
    cursor = page.docs.at(-1);
  }
}

function profileFactOrder(a: ProfileFact, b: ProfileFact): number {
  return (
    Number(b.pinned) - Number(a.pinned) ||
    b.importance - a.importance ||
    Number(b.confidence) - Number(a.confidence) ||
    b.createdAt.getTime() - a.createdAt.getTime() ||
    b.id.localeCompare(a.id)
  );
}

/** Installation-scoped profile reads with agent-scoped facts, card, and occasions. */
export class FirestoreProfilePeopleReadRepository implements ProfilePeopleReadRepository {
  readonly kind = 'profile-people-read-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly agentId: string,
  ) {}

  async getOwnerContact(): Promise<ProfileContact | null> {
    const rows = await collect<ProfileContact>(
      this.store.collection('contacts').where('trust', '==', 'owner'),
    );
    return rows.find((row) => row.trust === 'owner') ?? null;
  }

  async getContact(id: string): Promise<ProfileContact | null> {
    const doc = await this.store.doc('contacts', id).get();
    if (!doc.exists) return null;
    const row = decodeRecord<ProfileContact>(doc.data());
    return row.id === id ? row : null;
  }

  async listContacts(): Promise<ProfileContact[]> {
    const rows = await collect<ProfileContact>(this.store.collection('contacts'));
    return rows.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  async getFacts(
    contactId: string,
    limit: number,
  ): Promise<{ rows: ProfileFact[]; total: number }> {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Invalid profile fact limit');
    const now = this.store.now();
    const candidates = await collect<ProfileFact>(
      this.store
        .collection('memories')
        .where('agentId', '==', this.agentId)
        .where('subjectContactId', '==', contactId),
    );
    const active = candidates.filter(
      (row) =>
        row.agentId === this.agentId &&
        row.subjectContactId === contactId &&
        row.category === 'knowledge' &&
        row.quarantined === false &&
        (row.expiresAt === null || (row.expiresAt instanceof Date && row.expiresAt > now)) &&
        row.createdAt instanceof Date,
    );
    active.sort(profileFactOrder);
    return { rows: active.slice(0, limit), total: active.length };
  }

  async getOwnerCard(): Promise<{ content: string; compiledAt: Date } | null> {
    const doc = await this.store.doc('ownerCards', this.agentId).get();
    if (!doc.exists) return null;
    const row = decodeRecord<{ agentId: string; content: string; compiledAt: Date }>(doc.data());
    return row.agentId === this.agentId &&
      typeof row.content === 'string' &&
      row.compiledAt instanceof Date
      ? { content: row.content, compiledAt: row.compiledAt }
      : null;
  }

  async listOccasions(contactId: string): Promise<ProfileOccasion[]> {
    const rows = await collect<ProfileOccasion>(
      this.store
        .collection('occasions')
        .where('agentId', '==', this.agentId)
        .where('contactId', '==', contactId),
    );
    return rows
      .filter((row) => row.agentId === this.agentId && row.contactId === contactId)
      .sort((a, b) => a.month - b.month || a.day - b.day || a.id.localeCompare(b.id));
  }
}
