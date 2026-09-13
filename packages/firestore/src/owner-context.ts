import type {
  OwnerAmbientSnapshot,
  OwnerCommitment,
  OwnerContextRepository,
  OwnerLocationPing,
} from '@assistant/persistence';
import type { QueryDocumentSnapshot } from '@google-cloud/firestore';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const SNOOZED_PAGE_SIZE = 100;
const MAX_SNOOZED_SCAN = 10_000;

function boundedCommitmentLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 60) {
    throw new Error('Owner context commitment limit must be between 1 and 60');
  }
  return limit;
}

function decodedIdentityMatches(
  doc: FirebaseFirestore.DocumentSnapshot,
  value: { id?: unknown },
): boolean {
  return typeof value.id === 'string' && documentKey(value.id) === doc.id;
}

/**
 * Firestore layout for private chat context, below the installation document:
 *
 * - `ownerCards/{base64url(agentId)}`: `{ agentId, content, compiledAt }`
 * - `ambientSnapshots/{base64url(agentId)}`: one current cache row per agent
 * - `locationPings/{base64url(pingId)}` and `commitments/{base64url(id)}`
 *
 * Owner-card reads address the authenticated agent's document directly and
 * require its stored `agentId` to match. A malformed or foreign document is
 * ignored; its content is never treated as installation-global context.
 */
export class FirestoreOwnerContextRepository implements OwnerContextRepository {
  readonly kind = 'owner-context-repository' as const;

  constructor(readonly store: InstallationStore) {}

  async getOwnerCard(agentId: string) {
    const snapshot = await this.store.doc('ownerCards', agentId).get();
    if (!snapshot.exists) return null;
    const row = decodeRecord<{ agentId?: unknown; content?: unknown; compiledAt?: unknown }>(
      snapshot.data(),
    );
    if (
      row.agentId !== agentId ||
      typeof row.content !== 'string' ||
      !(row.compiledAt instanceof Date)
    ) {
      return null;
    }
    return { content: row.content, compiledAt: row.compiledAt };
  }

  async getAmbientSnapshot(agentId: string) {
    const snapshot = await this.store.doc('ambientSnapshots', agentId).get();
    if (!snapshot.exists) return null;
    const row = decodeRecord<OwnerAmbientSnapshot>(snapshot.data());
    if (
      row.agentId !== agentId ||
      typeof row.block !== 'string' ||
      !(row.computedAt instanceof Date)
    ) {
      return null;
    }
    return row;
  }

  async getLatestLocation({
    agentId,
    notBefore,
    notAfter,
    source,
  }: {
    agentId: string;
    notBefore: Date;
    notAfter: Date;
    source?: string;
  }) {
    let query = this.store
      .collection('locationPings')
      .where('agentId', '==', agentId)
      .where('capturedAt', '>=', notBefore)
      .where('capturedAt', '<=', notAfter);
    if (source) query = query.where('source', '==', source);
    const snapshot = await query.orderBy('capturedAt', 'desc').limit(1).get();
    const doc = snapshot.docs[0];
    if (!doc) return null;
    const row = decodeRecord<OwnerLocationPing>(doc.data());
    if (
      row.agentId !== agentId ||
      !decodedIdentityMatches(doc, row) ||
      !(row.capturedAt instanceof Date) ||
      row.capturedAt < notBefore ||
      row.capturedAt > notAfter ||
      (Boolean(source) && row.source !== source)
    ) {
      return null;
    }
    return row;
  }

  async listOpenCommitments({
    agentId,
    now,
    limit: requestedLimit,
  }: {
    agentId: string;
    now: Date;
    limit: number;
  }) {
    const limit = boundedCommitmentLimit(requestedLimit);
    const base = this.store.collection('commitments').where('agentId', '==', agentId);
    const [open, snoozed] = await Promise.all([
      base.where('status', '==', 'open').orderBy('updatedAt', 'desc').limit(limit).get(),
      this.listElapsedSnoozes(base, agentId, now, limit),
    ]);
    const rows: OwnerCommitment[] = [];
    for (const doc of [...open.docs, ...snoozed]) {
      const row = decodeRecord<OwnerCommitment>(doc.data());
      if (
        row.agentId !== agentId ||
        !decodedIdentityMatches(doc, row) ||
        !(row.updatedAt instanceof Date) ||
        (row.status !== 'open' &&
          !(row.status === 'snoozed' && row.snoozedUntil instanceof Date && row.snoozedUntil < now))
      ) {
        continue;
      }
      rows.push(row);
    }
    return rows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()).slice(0, limit);
  }

  private async listElapsedSnoozes(
    base: FirebaseFirestore.Query,
    agentId: string,
    now: Date,
    limit: number,
  ): Promise<QueryDocumentSnapshot[]> {
    const eligible: QueryDocumentSnapshot[] = [];
    let cursor: QueryDocumentSnapshot | undefined;
    let scanned = 0;
    while (eligible.length < limit && scanned < MAX_SNOOZED_SCAN) {
      const pageLimit = Math.min(SNOOZED_PAGE_SIZE, MAX_SNOOZED_SCAN - scanned);
      let query = base
        .where('status', '==', 'snoozed')
        .orderBy('updatedAt', 'desc')
        .limit(pageLimit);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      if (page.empty) break;
      scanned += page.size;
      for (const doc of page.docs) {
        const row = decodeRecord<Partial<OwnerCommitment>>(doc.data());
        if (
          row.agentId === agentId &&
          row.status === 'snoozed' &&
          row.snoozedUntil instanceof Date &&
          row.snoozedUntil < now &&
          row.updatedAt instanceof Date &&
          decodedIdentityMatches(doc, row)
        ) {
          eligible.push(doc);
        }
        if (eligible.length === limit) break;
      }
      cursor = page.docs.at(-1);
      if (page.size < pageLimit) break;
    }
    // Keep each request and the total query cost bounded. Exceeding this gate
    // fails closed instead of silently returning a wrongly ranked older row.
    if (eligible.length < limit && scanned >= MAX_SNOOZED_SCAN && cursor) {
      const overflow = await base
        .where('status', '==', 'snoozed')
        .orderBy('updatedAt', 'desc')
        .startAfter(cursor)
        .limit(1)
        .get();
      if (!overflow.empty) {
        throw new Error(`Owner context snoozed commitment scan exceeded ${MAX_SNOOZED_SCAN}`);
      }
    }
    return eligible;
  }
}
