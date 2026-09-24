import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FirestoreOwnerAuthRepository,
  type NewOwnerPasskey,
  OwnerAuthRejectedError,
} from './owner-auth.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

const hex = (value: string) => createHash('sha256').update(value).digest('hex');

function passkey(id: string, counter = 0): NewOwnerPasskey {
  return {
    id: `credential-${id}-0000`,
    publicKey: `public-key-${id}-0000000000`,
    counter,
    transports: ['internal', 'hybrid'],
    deviceType: 'multiDevice',
    backedUp: true,
    label: `Passkey ${id}`,
  };
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OwnerAuthRejectedError) return error.code;
    throw error;
  }
  throw new Error('expected rejection');
}

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore owner authentication', () => {
  let store: InstallationStore;
  let repository: FirestoreOwnerAuthRepository;
  let now = new Date('2026-09-23T12:00:00Z');
  const later = () => new Date(now.getTime() + 10 * 60_000);
  let challengeSeq = 0;
  const challenge = () => ({ key: hex(`challenge-${challengeSeq++}`), expiresAt: later() });

  beforeEach(() => {
    now = new Date('2026-09-23T12:00:00Z');
    store = emulatorStore(() => now);
    repository = new FirestoreOwnerAuthRepository(store);
  });

  afterEach(async () => disposeStore(store));

  async function claimOwner(): Promise<number> {
    await repository.issueClaim({
      verifier: hex('claim'),
      grant: 'claim',
      expiresAt: new Date(now.getTime() + 3600_000),
    });
    const result = await repository.registerPasskey({
      challenge: challenge(),
      authorization: { kind: 'claim', verifier: hex('claim') },
      passkey: passkey('first'),
      nextRecoveryVerifier: hex('recovery-1'),
    });
    return result.sessionGeneration;
  }

  it('claims once with a single-use claim and refuses a second first-claim', async () => {
    expect(await repository.state()).toMatchObject({ claimed: false, sessionGeneration: 0 });
    expect(await rejection(repository.checkClaim(hex('claim')))).toBe('claim_invalid');
    const generation = await claimOwner();
    expect(generation).toBe(1);
    expect(await repository.state()).toMatchObject({
      claimed: true,
      sessionGeneration: 1,
      recoveryConfigured: true,
    });
    // The consumed claim cannot register another passkey.
    expect(
      await rejection(
        repository.registerPasskey({
          challenge: challenge(),
          authorization: { kind: 'claim', verifier: hex('claim') },
          passkey: passkey('second'),
          nextRecoveryVerifier: hex('recovery-2'),
        }),
      ),
    ).toBe('claim_invalid');
    // A fresh first-claim cannot be issued over an owned installation.
    expect(
      await rejection(
        repository.issueClaim({
          verifier: hex('again'),
          grant: 'claim',
          expiresAt: new Date(now.getTime() + 3600_000),
        }),
      ),
    ).toBe('already_claimed');
  });

  it('refuses expired claims and recovery claims on an unclaimed installation', async () => {
    expect(
      await rejection(
        repository.issueClaim({
          verifier: hex('recovery-claim'),
          grant: 'recovery',
          expiresAt: new Date(now.getTime() + 3600_000),
        }),
      ),
    ).toBe('not_claimed');
    await repository.issueClaim({
      verifier: hex('claim'),
      grant: 'claim',
      expiresAt: new Date(now.getTime() + 60_000),
    });
    expect(await repository.checkClaim(hex('claim'))).toBe('claim');
    now = new Date(now.getTime() + 61_000);
    expect(await rejection(repository.checkClaim(hex('claim')))).toBe('claim_invalid');
  });

  it('allows only one of two concurrent claim registrations', async () => {
    await repository.issueClaim({
      verifier: hex('claim'),
      grant: 'claim',
      expiresAt: new Date(now.getTime() + 3600_000),
    });
    const results = await Promise.allSettled(
      ['a', 'b'].map((id) =>
        repository.registerPasskey({
          challenge: challenge(),
          authorization: { kind: 'claim', verifier: hex('claim') },
          passkey: passkey(id),
          nextRecoveryVerifier: hex(`recovery-${id}`),
        }),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await repository.listPasskeys()).filter((key) => !key.revokedAt)).toHaveLength(1);
  });

  it('rejects challenge replay and enforces counters on login', async () => {
    await claimOwner();
    const used = challenge();
    await repository.recordLogin({
      challenge: used,
      credentialId: passkey('first').id,
      counter: 0,
    });
    expect(
      await rejection(
        repository.recordLogin({ challenge: used, credentialId: passkey('first').id, counter: 0 }),
      ),
    ).toBe('challenge_replayed');
    await repository.recordLogin({
      challenge: challenge(),
      credentialId: passkey('first').id,
      counter: 5,
    });
    expect(
      await rejection(
        repository.recordLogin({
          challenge: challenge(),
          credentialId: passkey('first').id,
          counter: 5,
        }),
      ),
    ).toBe('passkey_counter');
    expect(
      await rejection(
        repository.recordLogin({
          challenge: challenge(),
          credentialId: passkey('missing').id,
          counter: 0,
        }),
      ),
    ).toBe('passkey_unknown');
    expect(
      await rejection(
        repository.recordLogin({
          challenge: { key: hex('late'), expiresAt: new Date(now.getTime() - 1) },
          credentialId: passkey('first').id,
          counter: 9,
        }),
      ),
    ).toBe('challenge_expired');
  });

  it('adds a second passkey from a live session and never removes the last one', async () => {
    const generation = await claimOwner();
    await repository.registerPasskey({
      challenge: challenge(),
      authorization: { kind: 'session', generation },
      passkey: passkey('second'),
    });
    expect(await rejection(repository.revokePasskey(passkey('first').id, generation + 7))).toBe(
      'session_revoked',
    );
    await repository.revokePasskey(passkey('first').id, generation);
    const state = await repository.state();
    expect(state.sessionGeneration).toBe(generation + 1);
    expect(
      await rejection(repository.revokePasskey(passkey('second').id, state.sessionGeneration)),
    ).toBe('last_passkey');
    expect(
      await rejection(
        repository.recordLogin({
          challenge: challenge(),
          credentialId: passkey('first').id,
          counter: 0,
        }),
      ),
    ).toBe('passkey_unknown');
    // The old session generation can no longer add credentials.
    expect(
      await rejection(
        repository.registerPasskey({
          challenge: challenge(),
          authorization: { kind: 'session', generation },
          passkey: passkey('third'),
        }),
      ),
    ).toBe('session_revoked');
  });

  it('recovers with the offline code once, rotates it, and signs out other sessions', async () => {
    const generation = await claimOwner();
    await repository.checkRecoveryCode(hex('recovery-1'));
    const recovered = await repository.registerPasskey({
      challenge: challenge(),
      authorization: { kind: 'recovery-code', verifier: hex('recovery-1') },
      passkey: passkey('replacement'),
      nextRecoveryVerifier: hex('recovery-2'),
    });
    expect(recovered.sessionGeneration).toBe(generation + 1);
    expect(await rejection(repository.checkRecoveryCode(hex('recovery-1')))).toBe(
      'recovery_invalid',
    );
    await repository.checkRecoveryCode(hex('recovery-2'));
    await repository.rotateRecoveryCode({
      verifier: hex('recovery-3'),
      generation: recovered.sessionGeneration,
    });
    expect(await rejection(repository.checkRecoveryCode(hex('recovery-2')))).toBe(
      'recovery_invalid',
    );
  });

  it('lets the cloud owner issue a recovery claim that consumes once', async () => {
    const generation = await claimOwner();
    await repository.issueClaim({
      verifier: hex('cloud-recovery'),
      grant: 'recovery',
      expiresAt: new Date(now.getTime() + 3600_000),
    });
    expect(await repository.checkClaim(hex('cloud-recovery'))).toBe('recovery');
    const result = await repository.registerPasskey({
      challenge: challenge(),
      authorization: { kind: 'claim', verifier: hex('cloud-recovery') },
      passkey: passkey('cloud'),
      nextRecoveryVerifier: hex('recovery-cloud'),
    });
    expect(result.sessionGeneration).toBe(generation + 1);
    expect(await rejection(repository.checkClaim(hex('cloud-recovery')))).toBe('claim_invalid');
    expect(await repository.state()).toMatchObject({ claimed: true });
  });

  it('issues, lists, and revokes per-device mobile credentials', async () => {
    const generation = await claimOwner();
    const device = await repository.createDevice({
      id: 'device0000000000a',
      name: 'Phone\u0007',
      verifier: hex('device-secret'),
      generation,
    });
    expect(device.name).toBe('Phone');
    expect((await repository.getDevice('device0000000000a'))?.verifier).toBe(hex('device-secret'));
    const listed = await repository.listDevices();
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty('verifier');
    await repository.revokeDevice('device0000000000a', generation);
    expect((await repository.getDevice('device0000000000a'))?.revokedAt).toBeInstanceOf(Date);
    expect(await rejection(repository.revokeDevice('device0000000000b', generation))).toBe(
      'device_unknown',
    );
    await repository.revokeSessions(generation);
    expect(
      await rejection(
        repository.createDevice({
          id: 'device0000000000c',
          name: 'Tablet',
          verifier: hex('other'),
          generation,
        }),
      ),
    ).toBe('session_revoked');
  });
});
