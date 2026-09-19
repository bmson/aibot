import { describe, expect, it } from 'vitest';
import { decodeRecord } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';
import { FirestoreWatchRepository } from './watches.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore watches', () => {
  it('creates owner-scoped watches and enforces cancellation ownership', async () => {
    const store = emulatorStore();
    try {
      const repository = new FirestoreWatchRepository(store);
      const now = new Date('2026-09-19T12:00:00Z');
      const watch = await repository.create({
        agentId: 'agent-a',
        kind: 'email',
        tier: 'notify',
        name: 'Recruiter',
        match: { expectedSenderEmails: ['recruiter@example.com'] },
        maxFires: null,
        expiresAt: new Date('2026-10-19T12:00:00Z'),
      });
      expect((await repository.list('agent-a')).map((row) => row.id)).toContain(watch.id);
      expect(await repository.list('agent-b')).toEqual([]);
      expect(await repository.cancel('agent-b', watch.id, now)).toBeNull();
      expect(await repository.cancel('agent-a', watch.id, now)).toEqual({
        status: 'cancelled',
        cancelled: true,
      });
    } finally {
      await disposeStore(store);
    }
  });

  it('deduplicates a trigger and serializes distinct fires at maxFires', async () => {
    const store = emulatorStore();
    try {
      const repository = new FirestoreWatchRepository(store);
      const now = new Date('2026-09-19T12:00:00Z');
      const watch = await repository.create({
        agentId: 'agent-a',
        kind: 'email',
        tier: 'notify',
        name: 'Bounded',
        match: {},
        maxFires: 2,
        expiresAt: new Date('2026-10-19T12:00:00Z'),
      });
      const fire = (triggerRef: string) =>
        repository.recordFire({
          watchId: watch.id,
          agentId: 'agent-a',
          triggerRef,
          summary: triggerRef,
          excerpt: '',
          now,
        });
      const duplicate = await Promise.all([fire('gmail:one'), fire('gmail:one')]);
      expect(duplicate.filter((result) => result.recorded)).toHaveLength(1);
      const distinct = await Promise.all([fire('gmail:two'), fire('gmail:three')]);
      expect(distinct.filter((result) => result.recorded)).toHaveLength(1);
      const saved = decodeRecord<{ fireCount: number; status: string }>(
        (await store.doc('watches', watch.id).get()).data(),
      );
      expect(saved).toMatchObject({ fireCount: 2, status: 'fired' });
      const fires = await store.collection('watchFires').where('watchId', '==', watch.id).get();
      expect(fires.size).toBe(2);
    } finally {
      await disposeStore(store);
    }
  });

  it('expires due watches and claims each due web poll once', async () => {
    const store = emulatorStore();
    try {
      const repository = new FirestoreWatchRepository(store);
      const now = new Date('2026-09-19T12:00:00Z');
      const active = await repository.create({
        agentId: 'agent-a',
        kind: 'web',
        tier: 'notify',
        name: 'Page',
        match: { url: 'https://example.com', mode: 'change' },
        maxFires: null,
        expiresAt: new Date('2026-09-20T12:00:00Z'),
        nextPollAt: now,
        pollIntervalSeconds: 60,
      });
      const expired = await repository.create({
        agentId: 'agent-a',
        kind: 'web',
        tier: 'notify',
        name: 'Old',
        match: {},
        maxFires: null,
        expiresAt: new Date('2026-09-18T12:00:00Z'),
        nextPollAt: now,
      });
      expect(await repository.expire('agent-a', now)).toBe(1);
      const claims = await Promise.all([
        repository.claimDueWeb(now, 10, 3600),
        repository.claimDueWeb(now, 10, 3600),
      ]);
      expect(claims.flat().map((row) => row.id)).toEqual([active.id]);
      expect((await store.doc('watches', expired.id).get()).get('status')).toBe('expired');

      const staleClaim = claims.flat()[0];
      if (!staleClaim?.nextPollAt) throw new Error('missing first claim');
      const newer = await repository.claimDueWeb(staleClaim.nextPollAt, 10, 3600);
      expect(newer).toHaveLength(1);
      expect(
        await repository.updateWeb({
          watchId: active.id,
          state: { fingerprint: 'stale' },
          now,
          expectedNextPollAt: staleClaim.nextPollAt,
        }),
      ).toBe(false);
      expect((await store.doc('watches', active.id).get()).get('state')).toEqual({});
      expect(
        await repository.recordFire({
          watchId: active.id,
          agentId: 'agent-a',
          triggerRef: 'web:stale',
          summary: 'stale',
          excerpt: '',
          state: { fingerprint: 'stale-fire' },
          now,
          expectedNextPollAt: staleClaim.nextPollAt,
        }),
      ).toMatchObject({ recorded: false });
      expect((await store.doc('watches', active.id).get()).get('state')).toEqual({});
      expect(
        await store.collection('watchFires').where('watchId', '==', active.id).get(),
      ).toHaveProperty('size', 0);
    } finally {
      await disposeStore(store);
    }
  });

  it('does not overwrite cancellation while expiring the same due watch', async () => {
    const store = emulatorStore();
    try {
      const repository = new FirestoreWatchRepository(store);
      const now = new Date('2026-09-19T12:00:00Z');
      const watch = await repository.create({
        agentId: 'agent-a',
        kind: 'email',
        tier: 'notify',
        name: 'Race',
        match: {},
        maxFires: null,
        expiresAt: new Date('2026-09-19T11:00:00Z'),
      });
      const [cancelled] = await Promise.all([
        repository.cancel('agent-a', watch.id, now),
        repository.expire('agent-a', now),
      ]);
      const status = (await store.doc('watches', watch.id).get()).get('status');
      if (cancelled?.cancelled) expect(status).toBe('cancelled');
      else expect(status).toBe('expired');
    } finally {
      await disposeStore(store);
    }
  });
});
