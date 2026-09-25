import { createHash, randomUUID } from 'node:crypto';
import type {
  ApplicationConfirmationRecord,
  ApplicationConfirmationRepository,
  CreateApplicationWatchInput,
  Records,
} from '@assistant/persistence';
import type { DocumentSnapshot, Query } from '@google-cloud/firestore';
import { assertPrivacyErasureInactiveInTransaction } from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

const AWAITING = 'awaiting_confirmation';
/** Watches one owner ever creates are few; this bounds the rare expiry scan. */
const EXPIRY_BATCH = 200;

function record(snapshot: DocumentSnapshot): ApplicationConfirmationRecord | null {
  if (!snapshot.exists) return null;
  const row = decodeRecord<ApplicationConfirmationRecord>(snapshot.data());
  return typeof row.id === 'string' &&
    documentKey(row.id) === snapshot.id &&
    row.expiresAt instanceof Date &&
    Array.isArray(row.expectedSenderEmails)
    ? row
    : null;
}

/** One active watch per `(agentId, token)`: the marker names the watch that holds it. */
function tokenMarkerId(agentId: string, tokenHash: string): string {
  return `application-token:${createHash('sha256')
    .update(JSON.stringify([agentId, tokenHash]))
    .digest('hex')}`;
}

/**
 * Application confirmation watches on Firestore. Every transition rereads the
 * record inside its transaction and checks the status it leaves, matching the
 * guarded PostgreSQL updates.
 */
export class FirestoreApplicationConfirmationRepository
  implements ApplicationConfirmationRepository
{
  readonly kind = 'application-confirmation-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly agentId: string,
  ) {}

  private owned(agentId: string): void {
    if (agentId !== this.agentId)
      throw new Error('Application confirmation is outside the configured owner');
  }

  async createWatch(input: CreateApplicationWatchInput): Promise<ApplicationConfirmationRecord> {
    this.owned(input.agentId);
    const markerRef = this.store.doc(
      'applicationConfirmationTokens',
      tokenMarkerId(input.agentId, input.confirmationTokenHash),
    );
    // Imported watches predate the marker, so the active set is also queried.
    const imported = this.store
      .collection('applicationConfirmations')
      .where('agentId', '==', input.agentId)
      .where('confirmationTokenHash', '==', input.confirmationTokenHash)
      .where('status', '==', AWAITING)
      .limit(1);
    return this.store.db.runTransaction(async (tx) => {
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, input.agentId);
      const [marker, active] = await Promise.all([tx.get(markerRef), tx.get(imported)]);
      const heldBy = marker.exists ? marker.get('applicationId') : null;
      const holder =
        typeof heldBy === 'string'
          ? record(await tx.get(this.store.doc('applicationConfirmations', heldBy)))
          : null;
      if (!active.empty || holder?.status === AWAITING)
        throw new Error('an active confirmation watch already uses this token');

      const now = this.store.now();
      let conversationId = input.conversationId;
      if (!conversationId) {
        const conversation: Records['conversations'] = {
          id: randomUUID(),
          agentId: input.agentId,
          channel: 'chat',
          trust: 'owner',
          title: input.newConversationTitle,
          isPrimary: false,
          metadata: {},
          archivedAt: null,
          modelOverride: null,
          lastReadAt: null,
          createdAt: now,
          updatedAt: now,
        };
        tx.create(
          this.store.doc('conversations', conversation.id),
          encodeRecord({ ...conversation, archived: false }),
        );
        conversationId = conversation.id;
      }
      const row: ApplicationConfirmationRecord = {
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
        agentId: input.agentId,
        status: AWAITING,
        expiresAt: input.expiresAt,
        lastError: null,
        conversationId,
        role: input.role,
        sourceTaskId: input.sourceTaskId,
        company: input.company,
        expectedSenderEmails: input.expectedSenderEmails,
        confirmationTokenHash: input.confirmationTokenHash,
        confirmationTokenHint: input.confirmationTokenHint,
        trackerUpdate: input.trackerUpdate ?? null,
        documentUpdate: input.documentUpdate ?? null,
        actionState: input.actionState,
        confirmationMessageId: null,
        confirmationFrom: null,
        confirmedAt: null,
      };
      tx.create(this.store.doc('applicationConfirmations', row.id), encodeRecord(row));
      tx.set(markerRef, { agentId: input.agentId, applicationId: row.id, updatedAt: now });
      return row;
    });
  }

  async list(agentId: string, status?: string): Promise<ApplicationConfirmationRecord[]> {
    this.owned(agentId);
    let query: Query = this.store
      .collection('applicationConfirmations')
      .where('agentId', '==', agentId);
    if (status) query = query.where('status', '==', status);
    const snapshot = await query.orderBy('createdAt', 'desc').limit(100).get();
    return snapshot.docs.flatMap((doc) => {
      const row = record(doc);
      return row && row.agentId === agentId ? [row] : [];
    });
  }

  async cancel(agentId: string, id: string, now: Date) {
    this.owned(agentId);
    const ref = this.store.doc('applicationConfirmations', id);
    return this.store.db.runTransaction(async (tx) => {
      const current = record(await tx.get(ref));
      if (!current || current.agentId !== agentId) return null;
      if (current.status !== AWAITING)
        return { id: current.id, status: current.status, cancelled: false };
      tx.update(ref, encodeRecord({ status: 'cancelled', updatedAt: now }));
      return { id: current.id, status: 'cancelled', cancelled: true };
    });
  }

  async get(id: string): Promise<ApplicationConfirmationRecord | null> {
    const row = record(await this.store.doc('applicationConfirmations', id).get());
    return row && row.agentId === this.agentId ? row : null;
  }

  async updateActionState(
    id: string,
    input: Parameters<ApplicationConfirmationRepository['updateActionState']>[1],
  ): Promise<ApplicationConfirmationRecord | null> {
    const ref = this.store.doc('applicationConfirmations', id);
    return this.store.db.runTransaction(async (tx) => {
      const current = record(await tx.get(ref));
      if (!current || current.agentId !== this.agentId) return null;
      if (input.requireStatus && current.status !== input.requireStatus) return null;
      const next: ApplicationConfirmationRecord = {
        ...current,
        actionState: input.actionState,
        ...(input.lastError !== undefined ? { lastError: input.lastError } : {}),
        ...(input.status ? { status: input.status } : {}),
        updatedAt: input.now,
      };
      tx.update(
        ref,
        encodeRecord({
          actionState: next.actionState,
          lastError: next.lastError,
          status: next.status,
          updatedAt: input.now,
        }),
      );
      return next;
    });
  }

  async expireDue(now: Date, agentId?: string): Promise<ApplicationConfirmationRecord[]> {
    if (agentId) this.owned(agentId);
    let query: Query = this.store
      .collection('applicationConfirmations')
      .where('agentId', '==', this.agentId)
      .where('status', '==', AWAITING)
      .where('expiresAt', '<=', now);
    query = query.orderBy('expiresAt', 'asc').limit(EXPIRY_BATCH);
    const due = await query.get();
    const expired: ApplicationConfirmationRecord[] = [];
    for (const doc of due.docs) {
      const moved = await this.store.db.runTransaction(async (tx) => {
        const current = record(await tx.get(doc.ref));
        if (!current || current.status !== AWAITING || current.expiresAt > now) return null;
        tx.update(doc.ref, encodeRecord({ status: 'expired', updatedAt: now }));
        return { ...current, status: 'expired', updatedAt: now };
      });
      if (moved) expired.push(moved);
    }
    return expired;
  }

  async byConfirmationMessage(agentId: string, confirmationMessageId: string) {
    this.owned(agentId);
    const snapshot = await this.store
      .collection('applicationConfirmations')
      .where('agentId', '==', agentId)
      .where('confirmationMessageId', '==', confirmationMessageId)
      .limit(1)
      .get();
    return snapshot.docs[0] ? record(snapshot.docs[0]) : null;
  }

  async awaitingFrom(agentId: string, from: string, now: Date) {
    this.owned(agentId);
    const snapshot = await this.store
      .collection('applicationConfirmations')
      .where('agentId', '==', agentId)
      .where('status', '==', AWAITING)
      .where('expectedSenderEmails', 'array-contains', from)
      .limit(EXPIRY_BATCH)
      .get();
    return snapshot.docs.flatMap((doc) => {
      const row = record(doc);
      return row && row.expiresAt > now ? [row] : [];
    });
  }

  async claim(
    id: string,
    input: { confirmationMessageId: string; confirmationFrom: string; now: Date },
  ): Promise<ApplicationConfirmationRecord | null> {
    const ref = this.store.doc('applicationConfirmations', id);
    return this.store.db.runTransaction(async (tx) => {
      const current = record(await tx.get(ref));
      if (
        !current ||
        current.agentId !== this.agentId ||
        current.status !== AWAITING ||
        current.expiresAt <= input.now
      )
        return null;
      const claimed: ApplicationConfirmationRecord = {
        ...current,
        status: 'confirmation_received',
        confirmationMessageId: input.confirmationMessageId,
        confirmationFrom: input.confirmationFrom,
        confirmedAt: input.now,
        lastError: null,
        updatedAt: input.now,
      };
      tx.update(
        ref,
        encodeRecord({
          status: claimed.status,
          confirmationMessageId: claimed.confirmationMessageId,
          confirmationFrom: claimed.confirmationFrom,
          confirmedAt: claimed.confirmedAt,
          lastError: null,
          updatedAt: input.now,
        }),
      );
      return claimed;
    });
  }

  async toolCallStatus(idempotencyKey: string): Promise<string | null> {
    const mapping = await this.store.doc('toolCallIdempotency', idempotencyKey).get();
    const id = mapping.exists ? mapping.get('toolCallId') : null;
    if (typeof id === 'string') {
      const call = await this.store.doc('toolCalls', id).get();
      const status = call.exists ? call.get('status') : null;
      return typeof status === 'string' ? status : null;
    }
    const imported = await this.store
      .collection('toolCalls')
      .where('idempotencyKey', '==', idempotencyKey)
      .limit(1)
      .get();
    const status = imported.docs[0]?.get('status');
    return typeof status === 'string' ? status : null;
  }

  async settleExecutingToolCall(
    taskId: string,
    toolName: string,
    result: unknown,
    now: Date,
  ): Promise<void> {
    const executing = await this.store
      .collection('toolCalls')
      .where('taskId', '==', taskId)
      .where('toolName', '==', toolName)
      .where('status', '==', 'executing')
      .get();
    for (const doc of executing.docs) {
      await this.store.db.runTransaction(async (tx) => {
        const current = await tx.get(doc.ref);
        if (current.get('status') !== 'executing') return;
        tx.update(doc.ref, encodeRecord({ status: 'succeeded', result, finishedAt: now }));
      });
    }
  }
}
