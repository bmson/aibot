import { createHash } from 'node:crypto';
import type {
  PulseCalendarSnapshot,
  PulseCommitment,
  PulseMail,
  PulseRepository,
  Records,
} from '@assistant/persistence';
import type { SituationPackView } from '@assistant/persistence/situations';
import type { DocumentReference, QueryDocumentSnapshot } from '@google-cloud/firestore';
import { assertPrivacyErasureInactiveInTransaction } from './privacy-erasure.js';
import { FirestoreSituationPackReadRepository } from './situation-packs.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

/** Stored calendar events per owner: a day and a half of events plus a day of stale ones. */
const SNAPSHOT_LIMIT = 2_000;
/** Moments of one kind the pulse has ever said; one per change, far below this. */
const MOMENT_KEY_LIMIT = 5_000;
/** Recent actionable mail read before the finished-task check. */
const MAIL_SCAN = 100;
/** Soon-due open loops read before snoozes are dropped. */
const COMMITMENT_SCAN = 100;

function snapshotKey(calendarId: string, eventId: string): string {
  return JSON.stringify([calendarId, eventId]);
}

/** A stable id per `(agentId, calendarId, eventId)`: re-seen events update in place. */
function snapshotIdFor(agentId: string, calendarId: string, eventId: string): string {
  return `calendar-snapshot:${createHash('sha256')
    .update(JSON.stringify([agentId, calendarId, eventId]))
    .digest('hex')}`;
}

/** A stable id per `(agentId, momentKey)`, so concurrent claims converge on one document. */
function momentIdFor(agentId: string, momentKey: string): string {
  return `pulse-moment:${createHash('sha256')
    .update(JSON.stringify([agentId, momentKey]))
    .digest('hex')}`;
}

/**
 * The pulse on Firestore. The moment ledger is keyed by `(agentId, momentKey)`
 * like the PostgreSQL unique index; imported moments keep their random ids and
 * are found by query inside the claiming transaction.
 */
export class FirestorePulseRepository implements PulseRepository {
  readonly kind = 'pulse-repository' as const;
  private readonly packs: FirestoreSituationPackReadRepository;

  constructor(readonly store: InstallationStore) {
    this.packs = new FirestoreSituationPackReadRepository(store);
  }

  async deliveredSince(agentId: string, since: Date): Promise<number> {
    const result = await this.store
      .collection('proactiveMoments')
      .where('agentId', '==', agentId)
      .where('deliveredAt', '>=', since)
      .count()
      .get();
    return result.data().count;
  }

  async ambientDailyCap(agentId: string): Promise<number | null> {
    const snapshot = await this.store.doc('notificationPrefs', agentId).get();
    if (!snapshot.exists || snapshot.get('agentId') !== agentId) return null;
    const cap = snapshot.get('ambientDailyCap');
    return typeof cap === 'number' && Number.isFinite(cap) ? cap : null;
  }

  async momentKeys(agentId: string, kind: string): Promise<string[]> {
    const snapshot = await this.store
      .collection('proactiveMoments')
      .where('agentId', '==', agentId)
      .where('kind', '==', kind)
      .select('momentKey')
      .limit(MOMENT_KEY_LIMIT + 1)
      .get();
    if (snapshot.size > MOMENT_KEY_LIMIT) throw new Error('Pulse moment scan exceeded bound');
    return snapshot.docs.flatMap((doc) => {
      const key = doc.get('momentKey');
      return typeof key === 'string' ? [key] : [];
    });
  }

  private async snapshotDocs(agentId: string): Promise<QueryDocumentSnapshot[]> {
    const snapshot = await this.store
      .collection('calendarEventSnapshots')
      .where('agentId', '==', agentId)
      .limit(SNAPSHOT_LIMIT + 1)
      .get();
    if (snapshot.size > SNAPSHOT_LIMIT) throw new Error('Calendar snapshot scan exceeded bound');
    return snapshot.docs;
  }

  async calendarSnapshot(agentId: string): Promise<PulseCalendarSnapshot[]> {
    return (await this.snapshotDocs(agentId)).flatMap((doc) => {
      const row = decodeRecord<Records['calendarEventSnapshots']>(doc.data());
      if (row.agentId !== agentId || typeof row.calendarId !== 'string') return [];
      return [
        {
          calendarId: row.calendarId,
          eventId: row.eventId,
          iCalUID: row.iCalUID ?? null,
          summary: row.summary,
          start: row.start,
          end: row.end,
          status: row.status ?? null,
          attendeeResponseHash: row.attendeeResponseHash ?? {},
        },
      ];
    });
  }

  async syncCalendarSnapshot(
    agentId: string,
    input: Parameters<PulseRepository['syncCalendarSnapshot']>[1],
  ): Promise<void> {
    const docs = await this.snapshotDocs(agentId);
    const existing = new Map<
      string,
      { ref: DocumentReference; id: string; updatedAt: Date | null }
    >();
    for (const doc of docs) {
      const row = decodeRecord<Records['calendarEventSnapshots']>(doc.data());
      if (row.agentId !== agentId || typeof row.id !== 'string') continue;
      existing.set(snapshotKey(row.calendarId, row.eventId), {
        ref: doc.ref,
        id: row.id,
        updatedAt: row.updatedAt instanceof Date ? row.updatedAt : null,
      });
    }
    const writer = this.store.db.bulkWriter();
    const touched = new Set<string>();
    for (const { calendarId, eventId } of input.cancelled) {
      const key = snapshotKey(calendarId, eventId);
      const found = existing.get(key);
      if (found) writer.delete(found.ref);
      touched.add(key);
    }
    for (const row of input.seen) {
      const key = snapshotKey(row.calendarId, row.eventId);
      if (touched.has(key)) continue;
      touched.add(key);
      // Imported rows keep their ids; new rows get the stable id.
      const found = existing.get(key);
      const id = found?.id ?? snapshotIdFor(agentId, row.calendarId, row.eventId);
      const ref = found?.ref ?? this.store.doc('calendarEventSnapshots', id);
      const record: Records['calendarEventSnapshots'] = {
        id,
        agentId,
        calendarId: row.calendarId,
        eventId: row.eventId,
        iCalUID: row.iCalUID,
        summary: row.summary,
        start: row.start,
        end: row.end,
        status: row.status,
        attendeeResponseHash: row.attendeeResponseHash,
        updatedAt: input.now,
      };
      writer.set(ref, encodeRecord(record));
    }
    // Rows not seen for a day are long past or already reported.
    for (const [key, found] of existing) {
      if (touched.has(key)) continue;
      if (found.updatedAt && found.updatedAt < input.staleBefore) writer.delete(found.ref);
    }
    await writer.close();
  }

  async actionableMail(
    agentId: string,
    input: { since: Date; minImportance: number; limit: number },
  ): Promise<PulseMail[]> {
    const snapshot = await this.store
      .collection('emailIngest')
      .where('agentId', '==', agentId)
      .where('actionable', '==', true)
      .where('createdAt', '>=', input.since)
      .orderBy('createdAt', 'desc')
      .limit(MAIL_SCAN)
      .get();
    const candidates = snapshot.docs
      .flatMap((doc) => {
        const row = decodeRecord<Records['emailIngest']>(doc.data());
        return typeof row.id === 'string' &&
          documentKey(row.id) === doc.id &&
          row.agentId === agentId &&
          Number(row.importance) >= input.minImportance
          ? [row]
          : [];
      })
      .sort((a, b) => b.importance - a.importance);
    const rows: PulseMail[] = [];
    for (const row of candidates) {
      if (rows.length >= input.limit) break;
      // Nothing has picked it up: no triage task ran to completion on it.
      const handled = await this.store
        .collection('tasks')
        .where('externalEventId', '==', row.channelMessageId)
        .where('status', '==', 'done')
        .limit(1)
        .get();
      if (!handled.empty) continue;
      rows.push({
        channelMessageId: row.channelMessageId,
        fromEmail: row.fromEmail,
        fromName: row.fromName ?? null,
        subject: row.subject,
        importance: row.importance,
      });
    }
    return rows;
  }

  async dueCommitments(
    agentId: string,
    input: { now: Date; until: Date; limit: number },
  ): Promise<PulseCommitment[]> {
    const snapshot = await this.store
      .collection('commitments')
      .where('agentId', '==', agentId)
      .where('status', '==', 'open')
      .where('dueAt', '>=', input.now)
      .where('dueAt', '<=', input.until)
      .orderBy('dueAt', 'asc')
      .limit(COMMITMENT_SCAN)
      .get();
    return snapshot.docs
      .flatMap((doc) => {
        const row = decodeRecord<Records['commitments']>(doc.data());
        if (
          typeof row.id !== 'string' ||
          documentKey(row.id) !== doc.id ||
          row.agentId !== agentId ||
          !(row.dueAt instanceof Date) ||
          (row.snoozedUntil instanceof Date && row.snoozedUntil > input.now)
        )
          return [];
        return [{ id: row.id, title: row.title, nextAction: row.nextAction, dueAt: row.dueAt }];
      })
      .slice(0, input.limit);
  }

  async claimMoment(input: Parameters<PulseRepository['claimMoment']>[0]): Promise<string | null> {
    const id = momentIdFor(input.agentId, input.momentKey);
    const ref = this.store.doc('proactiveMoments', id);
    const imported = this.store
      .collection('proactiveMoments')
      .where('agentId', '==', input.agentId)
      .where('momentKey', '==', input.momentKey)
      .limit(1);
    return this.store.db.runTransaction(async (tx) => {
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, input.agentId);
      const [byId, byKey] = await Promise.all([tx.get(ref), tx.get(imported)]);
      if (byId.exists || !byKey.empty) return null;
      const row: Records['proactiveMoments'] = {
        id,
        agentId: input.agentId,
        kind: input.kind,
        summary: input.summary,
        momentKey: input.momentKey,
        pinged: false,
        deliveredAt: input.deliveredAt,
      };
      tx.create(ref, encodeRecord(row));
      return id;
    });
  }

  async markPinged(agentId: string, momentId: string, pinged: boolean): Promise<void> {
    await this.store.db.runTransaction(async (tx) => {
      const ref = this.store.doc('proactiveMoments', momentId);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists || snapshot.get('agentId') !== agentId) return;
      tx.update(ref, { pinged });
    });
  }

  async situationPacks(agentId: string): Promise<SituationPackView[]> {
    return this.packs.list(agentId);
  }
}
