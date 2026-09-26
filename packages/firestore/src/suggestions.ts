import { createHash } from 'node:crypto';
import type {
  CreateSuggestionRecord,
  SuggestionRecord,
  SuggestionRepository,
} from '@assistant/persistence';
import type { QueryDocumentSnapshot } from '@google-cloud/firestore';
import { withEmulatorTransactionRetry } from './emulator-transaction.js';
import { assertPrivacyErasureInactiveInTransaction } from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

const PAGE = 200;
/** Open proposals expire within days; far beyond what one owner ever has waiting. */
const OPEN_SCAN_LIMIT = 2_000;

/**
 * A UUID-shaped id fixed by `(agentId, sourceRef)`, so concurrent producers
 * converge on one document. Owner routes accept suggestion ids as UUIDs.
 */
export function suggestionIdFor(agentId: string, sourceRef: string): string {
  const hex = createHash('sha256')
    .update(JSON.stringify([agentId, sourceRef]))
    .digest('hex');
  const variant = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function valid(snapshot: QueryDocumentSnapshot, agentId: string): SuggestionRecord | null {
  const row = decodeRecord<SuggestionRecord>(snapshot.data());
  if (
    typeof row.id !== 'string' ||
    documentKey(row.id) !== snapshot.id ||
    row.agentId !== agentId ||
    !(row.expiresAt instanceof Date) ||
    !(row.createdAt instanceof Date)
  )
    return null;
  return row;
}

export class FirestoreSuggestionRepository implements SuggestionRepository {
  readonly kind = 'suggestion-repository' as const;

  constructor(readonly store: InstallationStore) {}

  async create(input: CreateSuggestionRecord): Promise<SuggestionRecord | null> {
    if (!input.agentId || !input.sourceRef) throw new Error('Invalid suggestion');
    const id = suggestionIdFor(input.agentId, input.sourceRef);
    const ref = this.store.doc('suggestions', id);
    // Imported proposals keep their random ids, so the source is also looked up.
    const existing = this.store
      .collection('suggestions')
      .where('agentId', '==', input.agentId)
      .where('sourceRef', '==', input.sourceRef)
      .limit(1);
    // Idempotent: a retry finds the row a committed attempt created and returns null.
    return withEmulatorTransactionRetry(() =>
      this.store.db.runTransaction(async (tx) => {
        await assertPrivacyErasureInactiveInTransaction(tx, this.store, input.agentId);
        const [byId, bySource] = await Promise.all([tx.get(ref), tx.get(existing)]);
        if (byId.exists || !bySource.empty) return null;
        const now = this.store.now();
        const row: SuggestionRecord = {
          id,
          createdAt: now,
          updatedAt: now,
          agentId: input.agentId,
          status: input.status ?? 'pending',
          expiresAt: input.expiresAt,
          conversationId: input.conversationId ?? null,
          origin: input.origin,
          snoozedUntil: null,
          summary: input.summary,
          proposedAction: input.proposedAction,
          sourceRef: input.sourceRef,
          acceptedTaskId: null,
        };
        tx.create(ref, encodeRecord(row));
        return row;
      }),
    );
  }

  async listOpen(agentId: string, now: Date): Promise<SuggestionRecord[]> {
    const rows: SuggestionRecord[] = [];
    let scanned = 0;
    let cursor: QueryDocumentSnapshot | undefined;
    for (;;) {
      let query = this.store
        .collection('suggestions')
        .where('agentId', '==', agentId)
        .where('status', 'in', ['pending', 'snoozed'])
        .orderBy('createdAt', 'asc')
        .orderBy('id', 'asc')
        .limit(PAGE);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      for (const doc of page.docs) {
        const row = valid(doc, agentId);
        if (
          row &&
          row.expiresAt > now &&
          (!(row.snoozedUntil instanceof Date) || row.snoozedUntil <= now)
        )
          rows.push(row);
      }
      scanned += page.size;
      if (page.size < PAGE) return rows;
      if (scanned >= OPEN_SCAN_LIMIT) throw new Error('Open suggestion scan exceeded bound');
      cursor = page.docs[page.docs.length - 1];
    }
  }
}
