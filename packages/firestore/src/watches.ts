import { randomUUID } from 'node:crypto';
import type { Records, WatchCreateInput, WatchRepository } from '@assistant/persistence';
import type { QueryDocumentSnapshot } from '@google-cloud/firestore';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

type Watch = Records['watches'];

function watchRecord(
  input: WatchCreateInput,
  id: string,
  conversationId: string,
  now: Date,
): Watch {
  return {
    id,
    agentId: input.agentId,
    conversationId,
    kind: input.kind,
    tier: input.tier,
    name: input.name,
    match: input.match,
    status: 'active',
    fireCount: 0,
    maxFires: input.maxFires,
    lastFiredAt: null,
    nextPollAt: input.nextPollAt ?? null,
    pollIntervalSeconds: input.pollIntervalSeconds ?? null,
    state: input.state ?? {},
    expiresAt: input.expiresAt,
    createdAt: now,
    updatedAt: now,
  };
}

export class FirestoreWatchRepository implements WatchRepository {
  readonly kind = 'watch-repository' as const;
  constructor(readonly store: InstallationStore) {}

  async create(input: WatchCreateInput): Promise<Watch> {
    const id = randomUUID();
    const conversationId = input.conversationId ?? randomUUID();
    return this.store.db.runTransaction(async (tx) => {
      const conversation = this.store.doc('conversations', conversationId);
      const existing = await tx.get(conversation);
      const now = this.store.now();
      if (existing.exists) {
        if (existing.get('agentId') !== input.agentId)
          throw new Error('watch chat belongs to another agent');
      } else if (input.conversationId) {
        throw new Error('watch chat does not exist');
      } else {
        tx.create(
          conversation,
          encodeRecord({
            id: conversationId,
            agentId: input.agentId,
            channel: 'chat',
            trust: 'owner',
            title: `Watch: ${input.name}`.slice(0, 80),
            isPrimary: false,
            archived: false,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            modelOverride: null,
            metadata: {},
            lastReadAt: null,
          }),
        );
      }
      const row = watchRecord(input, id, conversationId, now);
      tx.create(this.store.doc('watches', id), encodeRecord(row));
      return row;
    });
  }

  async list(agentId: string, status?: string, limit = 100) {
    let query = this.store.collection('watches').where('agentId', '==', agentId);
    if (status) query = query.where('status', '==', status);
    const snapshots = await query.orderBy('createdAt', 'desc').limit(limit).get();
    return snapshots.docs.map((doc) => decodeRecord<Watch>(doc.data()));
  }

  async cancel(agentId: string, watchId: string, now: Date) {
    const ref = this.store.doc('watches', watchId);
    return this.store.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return null;
      const row = decodeRecord<Watch>(snapshot.data());
      if (row.agentId !== agentId || documentKey(row.id) !== snapshot.id) return null;
      if (row.status !== 'active') return { status: row.status, cancelled: false };
      tx.update(ref, { status: 'cancelled', updatedAt: now });
      return { status: 'cancelled', cancelled: true };
    });
  }

  async expire(agentId: string | null, now: Date) {
    let total = 0;
    while (true) {
      const count = await this.store.db.runTransaction(async (tx) => {
        let query = this.store
          .collection('watches')
          .where('status', '==', 'active')
          .where('expiresAt', '<=', now);
        if (agentId) query = query.where('agentId', '==', agentId);
        const snapshots = await tx.get(query.limit(400));
        for (const snapshot of snapshots.docs)
          tx.update(snapshot.ref, { status: 'expired', updatedAt: now });
        return snapshots.size;
      });
      total += count;
      if (count < 400) return total;
    }
  }

  async emailCandidates(agentId: string, now: Date) {
    const rows: Watch[] = [];
    let cursor: QueryDocumentSnapshot | undefined;
    while (true) {
      let query = this.store
        .collection('watches')
        .where('agentId', '==', agentId)
        .where('status', '==', 'active')
        .where('kind', '==', 'email')
        .where('expiresAt', '>', now)
        .orderBy('expiresAt')
        .limit(400);
      if (cursor) query = query.startAfter(cursor);
      const snapshots = await query.get();
      rows.push(...snapshots.docs.map((doc) => decodeRecord<Watch>(doc.data())));
      cursor = snapshots.docs.at(-1);
      if (snapshots.size < 400) return rows;
    }
  }

  async claimDueWeb(now: Date, batch: number, defaultIntervalSeconds: number) {
    if (!Number.isFinite(defaultIntervalSeconds) || defaultIntervalSeconds <= 0)
      throw new Error('default web watch poll interval must be positive');
    return this.store.db.runTransaction(async (tx) => {
      const snapshots = await tx.get(
        this.store
          .collection('watches')
          .where('status', '==', 'active')
          .where('kind', '==', 'web')
          .where('nextPollAt', '<=', now)
          .orderBy('nextPollAt')
          .limit(batch),
      );
      const claimed: Watch[] = [];
      for (const snapshot of snapshots.docs) {
        const row = decodeRecord<Watch>(snapshot.data());
        if (row.expiresAt <= now) {
          tx.update(snapshot.ref, { status: 'expired', updatedAt: now });
          continue;
        }
        const configured = row.pollIntervalSeconds;
        const intervalSeconds =
          configured != null && Number.isFinite(configured) && configured > 0
            ? configured
            : defaultIntervalSeconds;
        const nextPollAt = new Date(now.getTime() + intervalSeconds * 1000);
        tx.update(snapshot.ref, { nextPollAt, updatedAt: now });
        claimed.push({ ...row, nextPollAt, updatedAt: now });
      }
      return claimed;
    });
  }

  async updateWeb(input: Parameters<WatchRepository['updateWeb']>[0]) {
    const ref = this.store.doc('watches', input.watchId);
    return this.store.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (
        !snapshot.exists ||
        snapshot.get('status') !== 'active' ||
        decodeRecord<Date>(snapshot.get('nextPollAt')).getTime() !==
          input.expectedNextPollAt.getTime()
      )
        return false;
      tx.update(
        ref,
        encodeRecord({
          state: input.state,
          status: input.expire ? 'expired' : 'active',
          updatedAt: input.now,
        }),
      );
      return true;
    });
  }

  async recordFire(input: Parameters<WatchRepository['recordFire']>[0]) {
    const watchRef = this.store.doc('watches', input.watchId);
    return this.store.db.runTransaction(async (tx) => {
      const watchSnapshot = await tx.get(watchRef);
      if (!watchSnapshot.exists) return { recorded: false, watch: null };
      const watch = decodeRecord<Watch>(watchSnapshot.data());
      if (watch.agentId !== input.agentId || documentKey(watch.id) !== watchSnapshot.id)
        return { recorded: false, watch: null };
      if (
        watch.status !== 'active' ||
        watch.expiresAt <= input.now ||
        (input.expectedNextPollAt &&
          watch.nextPollAt?.getTime() !== input.expectedNextPollAt.getTime()) ||
        (watch.maxFires != null && watch.fireCount >= watch.maxFires)
      )
        return { recorded: false, watch };
      const duplicate = await tx.get(
        this.store
          .collection('watchFires')
          .where('watchId', '==', watch.id)
          .where('triggerRef', '==', input.triggerRef)
          .limit(1),
      );
      if (!duplicate.empty) {
        if (input.state !== undefined)
          tx.update(watchRef, encodeRecord({ state: input.state, updatedAt: input.now }));
        return { recorded: false, watch };
      }
      const fireCount = watch.fireCount + 1;
      const updated: Watch = {
        ...watch,
        fireCount,
        lastFiredAt: input.now,
        updatedAt: input.now,
        state: input.state ?? watch.state,
        status: watch.maxFires != null && fireCount >= watch.maxFires ? 'fired' : 'active',
      };
      const fireId = randomUUID();
      tx.create(
        this.store.doc('watchFires', fireId),
        encodeRecord({
          id: fireId,
          watchId: watch.id,
          agentId: input.agentId,
          triggerRef: input.triggerRef,
          summary: input.summary,
          excerpt: input.excerpt.slice(0, 2048),
          createdAt: input.now,
        }),
      );
      tx.set(watchRef, encodeRecord(updated));
      return { recorded: true, watch: updated };
    });
  }
}
