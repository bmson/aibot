import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FirestoreWatchRepository, type InstallationStore } from '@assistant/firestore';

/** Synthetic watch workload shared by the emulator and isolated real Firestore validation. */
export async function firestoreWatchSmoke(store: InstallationStore) {
  const repository = new FirestoreWatchRepository(store);
  const now = new Date(Date.now() + 2_000);
  const future = new Date(now.getTime() + 60 * 60_000);
  const past = new Date(now.getTime() - 60_000);
  const agentId = randomUUID();
  const otherAgentId = randomUUID();

  const email = await repository.create({
    agentId,
    kind: 'email',
    tier: 'suggest',
    name: 'Firestore validation email watch',
    match: { expectedSenderEmails: ['validation@example.com'] },
    maxFires: null,
    expiresAt: future,
  });
  const web = await repository.create({
    agentId,
    kind: 'web',
    tier: 'notify',
    name: 'Firestore validation web watch',
    match: { url: 'https://example.com', mode: 'change' },
    maxFires: null,
    expiresAt: future,
    nextPollAt: now,
    pollIntervalSeconds: 60,
  });
  await repository.create({
    agentId,
    kind: 'email',
    tier: 'notify',
    name: 'Firestore validation scoped expiry',
    match: {},
    maxFires: null,
    expiresAt: past,
  });
  await repository.create({
    agentId: otherAgentId,
    kind: 'email',
    tier: 'notify',
    name: 'Firestore validation global expiry',
    match: {},
    maxFires: null,
    expiresAt: past,
  });

  assert.equal((await repository.list(agentId)).length, 3);
  assert.equal((await repository.list(agentId, 'active')).length, 3);
  assert.deepEqual(
    (await repository.emailCandidates(agentId, now)).map((row) => row.id),
    [email.id],
  );

  const claimed = await repository.claimDueWeb(now, 10, 60);
  assert.deepEqual(
    claimed.map((row) => row.id),
    [web.id],
  );
  const claimedWeb = claimed[0];
  assert.ok(claimedWeb?.nextPollAt);
  assert.equal(
    await repository.updateWeb({
      watchId: web.id,
      state: { fingerprint: 'validation' },
      now,
      expectedNextPollAt: claimedWeb.nextPollAt,
    }),
    true,
  );

  const fire = {
    watchId: email.id,
    agentId,
    triggerRef: `validation:${randomUUID()}`,
    summary: 'Firestore validation watch fired',
    excerpt: 'synthetic validation data',
    now,
  };
  assert.equal((await repository.recordFire(fire)).recorded, true);
  // This second call exercises the equality-only watchFires lookup used for deduplication.
  assert.equal((await repository.recordFire(fire)).recorded, false);
  assert.equal(
    (
      await repository.getSuggestionContext({
        agentId,
        watchId: email.id,
        triggerRef: fire.triggerRef,
      })
    )?.fire.triggerRef,
    fire.triggerRef,
  );
  const suggestion = {
    agentId,
    watchId: email.id,
    triggerRef: fire.triggerRef,
    summary: 'Synthetic next step?',
    proposedAction: 'Draft a synthetic reply.',
    now,
  };
  assert.ok(await repository.commitSuggestion(suggestion));
  assert.ok(await repository.commitSuggestion(suggestion));
  assert.equal(
    (await store.collection('suggestions').where('agentId', '==', agentId).get()).size,
    1,
  );

  assert.equal(await repository.expire(agentId, now), 1);
  assert.equal(await repository.expire(null, now), 1);
  assert.equal(await repository.cancel(otherAgentId, web.id, now), null);
  assert.deepEqual(await repository.cancel(agentId, email.id, now), {
    status: 'cancelled',
    cancelled: true,
  });

  return {
    listed: 3,
    emailCandidates: 1,
    webClaims: 1,
    fires: 1,
    suggestions: 1,
    expired: 2,
  };
}
