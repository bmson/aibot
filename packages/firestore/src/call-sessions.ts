import { timingSafeEqual } from 'node:crypto';
import {
  ACTIVE_CALL_STATUSES,
  type CallCheckin,
  type CallSession,
  type CallSessionCreate,
  type CallSessionPatch,
  type CallSessionRepository,
  type CallTranscriptLine,
} from '@assistant/persistence';
import type { DocumentSnapshot, Transaction } from '@google-cloud/firestore';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

const COLLECTION = 'callSessions';
/** Firestore documents cap at 1 MiB; keep transcripts well under it. */
const MAX_TRANSCRIPT_LINES = 2_000;

function hashesMatch(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Phone calls for the configured owner. Every read checks the owner scope. */
export class FirestoreCallSessionRepository implements CallSessionRepository {
  readonly kind = 'call-session-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly agentId: string,
  ) {
    if (!agentId) throw new Error('Call sessions require an agent identity');
  }

  private owned(snapshot: DocumentSnapshot | undefined): CallSession | null {
    if (!snapshot?.exists) return null;
    const row = decodeRecord<CallSession>(snapshot.data());
    if (row?.agentId !== this.agentId || documentKey(row.id) !== snapshot.id) return null;
    return row;
  }

  private async mutate(
    id: string,
    change: (row: CallSession, tx: Transaction) => Partial<CallSession> | null,
  ): Promise<CallSession | null> {
    const ref = this.store.doc(COLLECTION, id);
    return this.store.db.runTransaction(async (tx) => {
      const row = this.owned(await tx.get(ref));
      if (!row) return null;
      const patch = change(row, tx);
      if (!patch) return null;
      const next = { ...row, ...patch, updatedAt: this.store.now() };
      tx.set(ref, encodeRecord(next));
      return next;
    });
  }

  async create(input: CallSessionCreate): Promise<CallSession> {
    if (input.agentId !== this.agentId) throw new Error('Call is outside the configured owner');
    const now = this.store.now();
    const row: CallSession = {
      ...input,
      createdAt: now,
      updatedAt: now,
      twilioCallSid: null,
      answeredBy: null,
      startedAt: null,
      endedAt: null,
      durationSeconds: null,
      transcript: [],
      notes: [],
      checkins: [],
      hangupRequested: false,
      outcome: null,
      summary: null,
      costUsd: null,
      error: null,
    };
    await this.store.doc(COLLECTION, input.id).create(encodeRecord(row));
    return row;
  }

  async get(id: string): Promise<CallSession | null> {
    return this.owned(await this.store.doc(COLLECTION, id).get());
  }

  async getByCallSid(callSid: string): Promise<CallSession | null> {
    const page = await this.store
      .collection(COLLECTION)
      .where('twilioCallSid', '==', callSid)
      .limit(2)
      .get();
    if (page.size !== 1) return null;
    return this.owned(page.docs[0]);
  }

  async list(agentId: string, limit: number): Promise<CallSession[]> {
    if (agentId !== this.agentId) return [];
    const page = await this.store
      .collection(COLLECTION)
      .where('agentId', '==', agentId)
      .orderBy('createdAt', 'desc')
      .limit(Math.max(1, Math.min(200, limit)))
      .get();
    return page.docs.flatMap((doc) => {
      const row = this.owned(doc);
      return row ? [row] : [];
    });
  }

  async countSince(agentId: string, since: Date): Promise<number> {
    if (agentId !== this.agentId) return 0;
    const result = await this.store
      .collection(COLLECTION)
      .where('agentId', '==', agentId)
      .where('createdAt', '>=', since)
      .count()
      .get();
    return result.data().count;
  }

  async activeCount(agentId: string): Promise<number> {
    if (agentId !== this.agentId) return 0;
    const result = await this.store
      .collection(COLLECTION)
      .where('agentId', '==', agentId)
      .where('status', 'in', [...ACTIVE_CALL_STATUSES])
      .count()
      .get();
    return result.data().count;
  }

  async update(id: string, patch: CallSessionPatch): Promise<void> {
    await this.mutate(id, () => patch);
  }

  async claimStream(id: string, tokenHash: string, now: Date): Promise<CallSession | null> {
    return this.mutate(id, (row) =>
      row.streamTokenHash &&
      hashesMatch(row.streamTokenHash, tokenHash) &&
      (ACTIVE_CALL_STATUSES as readonly string[]).includes(row.status)
        ? { streamTokenHash: null, status: 'in_progress', startedAt: now }
        : null,
    );
  }

  async finish(id: string, patch: CallSessionPatch): Promise<CallSession | null> {
    return this.mutate(id, (row) =>
      (ACTIVE_CALL_STATUSES as readonly string[]).includes(row.status) ? patch : null,
    );
  }

  async appendTranscript(id: string, lines: readonly CallTranscriptLine[]): Promise<void> {
    if (lines.length === 0) return;
    await this.mutate(id, (row) => ({
      transcript: [...((row.transcript as CallTranscriptLine[]) ?? []), ...lines].slice(
        -MAX_TRANSCRIPT_LINES,
      ),
    }));
  }

  async appendNote(id: string, note: string): Promise<void> {
    await this.mutate(id, (row) => ({
      notes: [...((row.notes as string[]) ?? []), note.slice(0, 500)].slice(-100),
    }));
  }

  async addCheckin(id: string, checkin: CallCheckin): Promise<void> {
    await this.mutate(id, (row) => ({
      checkins: [...((row.checkins as CallCheckin[]) ?? []), checkin],
    }));
  }

  async answerCheckin(
    agentId: string,
    id: string,
    checkinId: string,
    answer: string,
    via: string,
  ): Promise<boolean> {
    if (agentId !== this.agentId) return false;
    const updated = await this.mutate(id, (row) => {
      const checkins = (row.checkins as CallCheckin[]) ?? [];
      const target = checkins.find((checkin) => checkin.id === checkinId);
      if (!target || target.answer !== null) return null;
      return {
        checkins: checkins.map((checkin) =>
          checkin.id === checkinId
            ? {
                ...checkin,
                answer: answer.slice(0, 1_000),
                answeredAt: this.store.now().toISOString(),
                via,
              }
            : checkin,
        ),
      };
    });
    return updated !== null;
  }

  async requestHangup(agentId: string, id: string): Promise<boolean> {
    if (agentId !== this.agentId) return false;
    const updated = await this.mutate(id, (row) =>
      (ACTIVE_CALL_STATUSES as readonly string[]).includes(row.status)
        ? { hangupRequested: true }
        : null,
    );
    return updated !== null;
  }
}
