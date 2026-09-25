import {
  OwnerAuthRejectedError,
  type OwnerDevice,
  type OwnerPasskey,
  ownerSecretVerifier,
} from '@assistant/firestore';
import { describe, expect, it, vi } from 'vitest';
import { type OwnerAuthStore, OwnerPasskeyService, type WebAuthnFunctions } from './service';
import { signToken, verifyToken } from './tokens';

const SECRET = 'test-secret-that-is-long-enough-for-hkdf-0123456789';
const CLAIM = 'A'.repeat(43);

function fakeStore() {
  const passkeys = new Map<string, OwnerPasskey>();
  const devices = new Map<string, OwnerDevice>();
  const used = new Set<string>();
  const state = {
    claimed: false,
    generation: 0,
    claimVerifier: ownerSecretVerifier('claim', CLAIM) as string | null,
    recovery: null as string | null,
  };
  const store: OwnerAuthStore = {
    state: async () => ({
      claimed: state.claimed,
      claimedAt: state.claimed ? new Date() : null,
      sessionGeneration: state.generation,
      recoveryConfigured: state.recovery !== null,
    }),
    checkClaim: async (verifier) => {
      if (verifier !== state.claimVerifier || state.claimed)
        throw new OwnerAuthRejectedError('claim_invalid');
      return 'claim';
    },
    checkRecoveryCode: async (verifier) => {
      if (verifier !== state.recovery) throw new OwnerAuthRejectedError('recovery_invalid');
    },
    registerPasskey: async (input) => {
      if (used.has(input.challenge.key)) throw new OwnerAuthRejectedError('challenge_replayed');
      const auth = input.authorization;
      if (auth.kind === 'claim') {
        if (auth.verifier !== state.claimVerifier)
          throw new OwnerAuthRejectedError('claim_invalid');
        state.claimVerifier = null;
        state.claimed = true;
        state.generation = 1;
      } else if (auth.kind === 'recovery-code') {
        if (auth.verifier !== state.recovery) throw new OwnerAuthRejectedError('recovery_invalid');
        state.generation += 1;
      } else if (auth.generation !== state.generation) {
        throw new OwnerAuthRejectedError('session_revoked');
      }
      if (input.nextRecoveryVerifier) state.recovery = input.nextRecoveryVerifier;
      used.add(input.challenge.key);
      passkeys.set(input.passkey.id, {
        ...input.passkey,
        createdAt: new Date(),
        lastUsedAt: null,
        revokedAt: null,
      });
      return { sessionGeneration: state.generation };
    },
    getPasskey: async (id) => passkeys.get(id) ?? null,
    recordLogin: async (input) => {
      if (used.has(input.challenge.key)) throw new OwnerAuthRejectedError('challenge_replayed');
      used.add(input.challenge.key);
      return { sessionGeneration: state.generation };
    },
    listPasskeys: async () => [...passkeys.values()],
    revokePasskey: vi.fn(),
    revokeSessions: vi.fn(),
    rotateRecoveryCode: async ({ verifier }) => {
      state.recovery = verifier;
    },
    createDevice: async (input) => {
      const device = { ...input, createdAt: new Date(), revokedAt: null };
      devices.set(input.id, device);
      return device;
    },
    getDevice: async (id) => devices.get(id) ?? null,
    listDevices: async () => [...devices.values()],
    revokeDevice: async (id) => {
      const device = devices.get(id);
      if (device) device.revokedAt = new Date();
    },
  };
  return { store, state, passkeys, devices };
}

function fakeWebAuthn(overrides: Partial<WebAuthnFunctions> = {}) {
  let seq = 0;
  const calls: { expectedOrigin?: unknown; expectedRPID?: unknown; uv?: unknown }[] = [];
  const functions: WebAuthnFunctions = {
    generateRegistrationOptions: (async () => ({
      challenge: `reg-challenge-${seq++}`,
    })) as unknown as WebAuthnFunctions['generateRegistrationOptions'],
    generateAuthenticationOptions: (async () => ({
      challenge: `auth-challenge-${seq++}`,
    })) as unknown as WebAuthnFunctions['generateAuthenticationOptions'],
    verifyRegistrationResponse: (async (options: {
      expectedChallenge: unknown;
      expectedOrigin: unknown;
      expectedRPID: unknown;
      requireUserVerification: unknown;
      response: { id: string; challenge: string };
    }) => {
      calls.push({
        expectedOrigin: options.expectedOrigin,
        expectedRPID: options.expectedRPID,
        uv: options.requireUserVerification,
      });
      if (options.response.challenge !== options.expectedChallenge) return { verified: false };
      return {
        verified: true,
        registrationInfo: {
          credential: {
            id: options.response.id,
            publicKey: new Uint8Array(32).fill(7),
            counter: 0,
            transports: ['internal'],
          },
          credentialDeviceType: 'multiDevice',
          credentialBackedUp: true,
        },
      };
    }) as unknown as WebAuthnFunctions['verifyRegistrationResponse'],
    verifyAuthenticationResponse: (async (options: {
      expectedChallenge: unknown;
      response: { challenge: string };
    }) => ({
      verified: options.response.challenge === options.expectedChallenge,
      authenticationInfo: { newCounter: 0 },
    })) as unknown as WebAuthnFunctions['verifyAuthenticationResponse'],
    ...overrides,
  };
  return { functions, calls };
}

function service(store: OwnerAuthStore, webauthn: WebAuthnFunctions, now = () => new Date()) {
  return new OwnerPasskeyService({
    store,
    secret: SECRET,
    origin: 'https://assistant.example.com',
    rpId: 'assistant.example.com',
    rpName: 'Assistant',
    installationId: 'pilot',
    ownerName: 'Owner',
    webauthn,
    now,
  });
}

describe('owner tokens', () => {
  it('signs and expires tokens, and separates session from challenge keys', () => {
    const now = new Date('2026-09-23T12:00:00Z');
    const exp = Math.floor(now.getTime() / 1000) + 60;
    const token = signToken(SECRET, 'owner-session-v1', { exp });
    expect(verifyToken(SECRET, 'owner-session-v1', token, now)).toEqual({ exp });
    expect(verifyToken(SECRET, 'owner-challenge-v1', token, now)).toBeNull();
    expect(verifyToken(`${SECRET}x`, 'owner-session-v1', token, now)).toBeNull();
    expect(verifyToken(SECRET, 'owner-session-v1', token, new Date(exp * 1000))).toBeNull();
    const [body] = token.split('.');
    expect(verifyToken(SECRET, 'owner-session-v1', `${body}.AAAA`, now)).toBeNull();
    expect(verifyToken(SECRET, 'owner-session-v1', `${token}.extra`, now)).toBeNull();
  });
});

describe('OwnerPasskeyService', () => {
  it('claims with the setup code, returns a session and a one-time recovery code', async () => {
    const { store, state } = fakeStore();
    const { functions, calls } = fakeWebAuthn();
    const auth = service(store, functions);
    await expect(auth.claimOptions('B'.repeat(43))).rejects.toMatchObject({ status: 403 });
    await expect(auth.claimOptions('short')).rejects.toMatchObject({ code: 'claim_invalid' });
    const begin = await auth.claimOptions(CLAIM);
    const result = await auth.finishRegistration({
      challengeToken: begin.challengeToken,
      response: { id: 'credential-owner-0001', challenge: begin.options.challenge },
      label: 'Mac',
    });
    expect(calls[0]).toEqual({
      expectedOrigin: 'https://assistant.example.com',
      expectedRPID: 'assistant.example.com',
      uv: true,
    });
    expect(state.claimed).toBe(true);
    expect(result.recoveryCode).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){4}$/);
    expect(auth.readSession(result.session?.token)).toMatchObject({ gen: 1 });
    // Replaying the same challenge token cannot register again.
    await expect(
      auth.finishRegistration({
        challengeToken: begin.challengeToken,
        response: { id: 'credential-owner-0002', challenge: begin.options.challenge },
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('rejects mismatched challenges and forged challenge tokens', async () => {
    const { store } = fakeStore();
    const { functions } = fakeWebAuthn();
    const auth = service(store, functions);
    const begin = await auth.claimOptions(CLAIM);
    await expect(
      auth.finishRegistration({
        challengeToken: begin.challengeToken,
        response: { id: 'credential-owner-0001', challenge: 'other' },
      }),
    ).rejects.toMatchObject({ code: 'registration_invalid' });
    const forged = signToken(`${SECRET}-other`, 'owner-challenge-v1', {
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    await expect(
      auth.finishRegistration({ challengeToken: forged, response: {} }),
    ).rejects.toMatchObject({ code: 'challenge_invalid' });
  });

  it('requires the live session generation to add a passkey', async () => {
    const { store } = fakeStore();
    const { functions } = fakeWebAuthn();
    const auth = service(store, functions);
    const begin = await auth.claimOptions(CLAIM);
    const claimed = await auth.finishRegistration({
      challengeToken: begin.challengeToken,
      response: { id: 'credential-owner-0001', challenge: begin.options.challenge },
    });
    const session = claimed.session?.claims;
    if (!session) throw new Error('expected session');
    const add = await auth.addPasskeyOptions(session);
    await expect(
      auth.finishRegistration({
        challengeToken: add.challengeToken,
        response: { id: 'credential-owner-0002', challenge: add.options.challenge },
      }),
    ).rejects.toMatchObject({ code: 'session_required' });
    const added = await auth.finishRegistration({
      challengeToken: add.challengeToken,
      response: { id: 'credential-owner-0002', challenge: add.options.challenge },
      session,
    });
    expect(added).toEqual({});
  });

  it('signs in with a registered passkey and refuses unknown credentials', async () => {
    const { store } = fakeStore();
    const { functions } = fakeWebAuthn();
    const auth = service(store, functions);
    const begin = await auth.claimOptions(CLAIM);
    await auth.finishRegistration({
      challengeToken: begin.challengeToken,
      response: { id: 'credential-owner-0001', challenge: begin.options.challenge },
    });
    const login = await auth.loginOptions();
    await expect(
      auth.finishLogin({
        challengeToken: login.challengeToken,
        response: { id: 'credential-unknown-01', challenge: login.options.challenge },
      }),
    ).rejects.toMatchObject({ status: 401 });
    const session = await auth.finishLogin({
      challengeToken: login.challengeToken,
      response: { id: 'credential-owner-0001', challenge: login.options.challenge },
    });
    expect(session.claims.gen).toBe(1);
    // A registration challenge token is not accepted for login.
    await expect(
      auth.finishLogin({ challengeToken: begin.challengeToken, response: {} }),
    ).rejects.toMatchObject({ code: 'challenge_invalid' });
  });

  it('recovers with the saved code, normalizing spacing and case', async () => {
    const { store, state } = fakeStore();
    const { functions } = fakeWebAuthn();
    const auth = service(store, functions);
    const begin = await auth.claimOptions(CLAIM);
    const claimed = await auth.finishRegistration({
      challengeToken: begin.challengeToken,
      response: { id: 'credential-owner-0001', challenge: begin.options.challenge },
    });
    const code = claimed.recoveryCode ?? '';
    await expect(auth.recoveryOptions('00000-00000-00000-00000-00000')).rejects.toMatchObject({
      code: 'recovery_invalid',
    });
    const recovery = await auth.recoveryOptions(` ${code.toLowerCase().replaceAll('-', ' ')} `);
    const recovered = await auth.finishRegistration({
      challengeToken: recovery.challengeToken,
      response: { id: 'credential-owner-0003', challenge: recovery.options.challenge },
    });
    expect(state.generation).toBe(2);
    expect(recovered.recoveryCode).not.toBe(code);
    await expect(auth.recoveryOptions(code)).rejects.toMatchObject({ code: 'recovery_invalid' });
  });

  it('issues per-device credentials that verify until revoked', async () => {
    const { store } = fakeStore();
    const { functions } = fakeWebAuthn();
    const auth = service(store, functions);
    const token = await auth.createDevice({ sid: 's', gen: 1, iat: 0, exp: 0 }, 'Phone');
    expect(token).toMatch(/^asd1_[0-9a-f]{24}_[A-Za-z0-9_-]{43}$/);
    const id = token.split('_')[1] ?? '';
    expect(await auth.verifyDeviceToken(token)).toBe(id);
    expect(
      await auth.verifyDeviceToken(`${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`),
    ).toBeNull();
    await store.revokeDevice(id, 1);
    expect(await auth.verifyDeviceToken(token)).toBeNull();
  });
});
