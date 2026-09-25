import { createHash, randomBytes } from 'node:crypto';
import type { DocumentReference, Transaction } from '@google-cloud/firestore';
import { decodeRecord, encodeRecord, type InstallationStore } from './store.js';

/**
 * Owner authentication for customer installations that do not use a Google
 * OAuth client. Only verifiers (SHA-256 of high-entropy secrets) and public
 * passkey material are stored. Every state change that grants access commits
 * in one transaction with the single-use challenge marker it consumed.
 */

export const MAX_OWNER_PASSKEYS = 20;
export const OWNER_CLAIM_TTL_MS = 24 * 3600_000;
export const MAX_OWNER_DEVICES = 20;

export type OwnerClaimGrant = 'claim' | 'recovery';

export type OwnerAuthRejection =
  | 'already_claimed'
  | 'not_claimed'
  | 'claim_invalid'
  | 'recovery_invalid'
  | 'challenge_replayed'
  | 'challenge_expired'
  | 'session_revoked'
  | 'passkey_exists'
  | 'passkey_unknown'
  | 'passkey_counter'
  | 'passkey_limit'
  | 'last_passkey'
  | 'device_limit'
  | 'device_unknown';

export class OwnerAuthRejectedError extends Error {
  constructor(readonly code: OwnerAuthRejection) {
    super(`Owner authentication rejected: ${code}`);
    this.name = 'OwnerAuthRejectedError';
  }
}

export interface OwnerAuthState {
  claimed: boolean;
  claimedAt: Date | null;
  /** Bumped to revoke every existing browser session at once. */
  sessionGeneration: number;
  recoveryConfigured: boolean;
}

export interface OwnerPasskey {
  id: string;
  /** COSE public key, base64url. */
  publicKey: string;
  counter: number;
  transports: string[];
  deviceType: 'singleDevice' | 'multiDevice';
  backedUp: boolean;
  label: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export type NewOwnerPasskey = Pick<
  OwnerPasskey,
  'id' | 'publicKey' | 'counter' | 'transports' | 'deviceType' | 'backedUp' | 'label'
>;

export interface OwnerDevice {
  id: string;
  name: string;
  verifier: string;
  createdAt: Date;
  revokedAt: Date | null;
}

/** How a passkey registration is authorized. */
export type OwnerRegistrationAuthorization =
  | { kind: 'claim'; verifier: string }
  | { kind: 'recovery-code'; verifier: string }
  | { kind: 'session'; generation: number };

export interface OwnerChallengeUse {
  /** Stable, non-secret key derived from the challenge (e.g. its SHA-256). */
  key: string;
  expiresAt: Date;
}

type StateDoc = {
  claimedAt?: Date | null;
  sessionGeneration?: number;
  recoveryVerifier?: string | null;
  updatedAt?: Date;
};

type ClaimDoc = {
  verifier: string;
  grant: OwnerClaimGrant;
  issuedAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
};

export type OwnerSecretPurpose = 'claim' | 'recovery' | 'device';

/** Domain-separated SHA-256 verifier. Secrets are high entropy, so no slow KDF is needed. */
export function ownerSecretVerifier(purpose: OwnerSecretPurpose, secret: string): string {
  return createHash('sha256').update(`assistant-owner:${purpose}:${secret}`, 'utf8').digest('hex');
}

/** A 256-bit URL-safe secret for setup links and device credentials. */
export function generateOwnerSecret(): string {
  return randomBytes(32).toString('base64url');
}

const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A 125-bit offline recovery code in five readable groups (Crockford base32). */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(25);
  const chars = [...bytes].map((byte) => RECOVERY_ALPHABET[byte & 31]).join('');
  return chars.match(/.{5}/g)?.join('-') ?? chars;
}

/** Accept pasted codes with spaces, lowercase letters, or common look-alikes. */
export function normalizeRecoveryCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

const VERIFIER = /^[0-9a-f]{64}$/;
const CREDENTIAL_ID = /^[A-Za-z0-9_-]{16,1024}$/;
const DEVICE_ID = /^[a-z0-9]{16,40}$/;

function requireVerifier(value: string, label: string): void {
  if (!VERIFIER.test(value)) throw new Error(`${label} must be a SHA-256 hex verifier`);
}

function cleanLabel(value: string, fallback: string): string {
  const trimmed = [...value]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join('')
    .trim();
  return (trimmed || fallback).slice(0, 80);
}

export class FirestoreOwnerAuthRepository {
  constructor(readonly store: InstallationStore) {}

  private stateRef(): DocumentReference {
    return this.store.doc('ownerAuth', 'state');
  }

  private claimRef(): DocumentReference {
    return this.store.doc('ownerAuth', 'claim');
  }

  private passkeyRef(id: string): DocumentReference {
    return this.store.doc('ownerPasskeys', id);
  }

  private deviceRef(id: string): DocumentReference {
    return this.store.doc('ownerDevices', id);
  }

  private challengeRef(key: string): DocumentReference {
    return this.store.doc('ownerAuthChallenges', key);
  }

  private static decodeState(data: unknown): StateDoc {
    return data ? decodeRecord<StateDoc>(data) : {};
  }

  private static publicState(doc: StateDoc): OwnerAuthState {
    return {
      claimed: doc.claimedAt instanceof Date,
      claimedAt: doc.claimedAt instanceof Date ? doc.claimedAt : null,
      sessionGeneration: Number.isSafeInteger(doc.sessionGeneration)
        ? (doc.sessionGeneration as number)
        : 0,
      recoveryConfigured: typeof doc.recoveryVerifier === 'string',
    };
  }

  async state(): Promise<OwnerAuthState> {
    const snapshot = await this.stateRef().get();
    return FirestoreOwnerAuthRepository.publicState(
      FirestoreOwnerAuthRepository.decodeState(snapshot.data()),
    );
  }

  /**
   * Installer-only: replace any unconsumed claim with a new verifier. A first
   * claim requires an unclaimed installation; a cloud-owner recovery claim
   * requires an existing owner and cannot be used to take over a fresh one.
   */
  async issueClaim(input: {
    verifier: string;
    grant: OwnerClaimGrant;
    expiresAt: Date;
  }): Promise<void> {
    requireVerifier(input.verifier, 'Claim verifier');
    const now = this.store.now();
    if (!(input.expiresAt > now)) throw new Error('Claim expiry must be in the future');
    if (input.expiresAt.getTime() - now.getTime() > 7 * 24 * 3600_000)
      throw new Error('Claim expiry must be within seven days');
    await this.store.db.runTransaction(async (tx) => {
      const state = FirestoreOwnerAuthRepository.publicState(
        FirestoreOwnerAuthRepository.decodeState((await tx.get(this.stateRef())).data()),
      );
      if (input.grant === 'claim' && state.claimed)
        throw new OwnerAuthRejectedError('already_claimed');
      if (input.grant === 'recovery' && !state.claimed)
        throw new OwnerAuthRejectedError('not_claimed');
      const claim: ClaimDoc = {
        verifier: input.verifier,
        grant: input.grant,
        issuedAt: now,
        expiresAt: input.expiresAt,
        consumedAt: null,
      };
      tx.set(this.claimRef(), encodeRecord(claim));
    });
  }

  private async readClaim(
    read: (ref: DocumentReference) => Promise<{ data(): unknown; exists: boolean }>,
    verifier: string,
  ): Promise<ClaimDoc> {
    const snapshot = await read(this.claimRef());
    if (!snapshot.exists) throw new OwnerAuthRejectedError('claim_invalid');
    const claim = decodeRecord<ClaimDoc>(snapshot.data());
    if (
      claim.verifier !== verifier ||
      claim.consumedAt !== null ||
      !(claim.expiresAt instanceof Date) ||
      claim.expiresAt <= this.store.now()
    )
      throw new OwnerAuthRejectedError('claim_invalid');
    return claim;
  }

  /** Validate an unconsumed setup claim before presenting passkey options. */
  async checkClaim(verifier: string): Promise<OwnerClaimGrant> {
    requireVerifier(verifier, 'Claim verifier');
    const claim = await this.readClaim((ref) => ref.get(), verifier);
    const state = await this.state();
    if (claim.grant === 'claim' && state.claimed) throw new OwnerAuthRejectedError('claim_invalid');
    if (claim.grant === 'recovery' && !state.claimed)
      throw new OwnerAuthRejectedError('claim_invalid');
    return claim.grant;
  }

  async checkRecoveryCode(verifier: string): Promise<void> {
    requireVerifier(verifier, 'Recovery verifier');
    const snapshot = await this.stateRef().get();
    const state = FirestoreOwnerAuthRepository.decodeState(snapshot.data());
    if (!(state.claimedAt instanceof Date) || state.recoveryVerifier !== verifier)
      throw new OwnerAuthRejectedError('recovery_invalid');
  }

  private async consumeChallenge(tx: Transaction, challenge: OwnerChallengeUse): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(challenge.key)) throw new Error('Invalid challenge key');
    if (challenge.expiresAt <= this.store.now())
      throw new OwnerAuthRejectedError('challenge_expired');
    const snapshot = await tx.get(this.challengeRef(challenge.key));
    if (snapshot.exists) throw new OwnerAuthRejectedError('challenge_replayed');
  }

  private writeChallenge(tx: Transaction, challenge: OwnerChallengeUse, now: Date): void {
    // `expiresAt` supports an optional Firestore TTL policy on this collection.
    tx.create(
      this.challengeRef(challenge.key),
      encodeRecord({ consumedAt: now, expiresAt: challenge.expiresAt }),
    );
  }

  /**
   * Register a verified passkey. A claim or recovery grant is consumed in the
   * same transaction, and its replacement recovery verifier is stored.
   */
  async registerPasskey(input: {
    challenge: OwnerChallengeUse;
    authorization: OwnerRegistrationAuthorization;
    passkey: NewOwnerPasskey;
    /** Required for claim and recovery grants; the fresh offline recovery code verifier. */
    nextRecoveryVerifier?: string;
  }): Promise<{ sessionGeneration: number }> {
    const { passkey, authorization } = input;
    if (!CREDENTIAL_ID.test(passkey.id)) throw new Error('Invalid passkey credential ID');
    if (!/^[A-Za-z0-9_-]{16,4096}$/.test(passkey.publicKey))
      throw new Error('Invalid passkey public key');
    if (!Number.isSafeInteger(passkey.counter) || passkey.counter < 0)
      throw new Error('Invalid passkey counter');
    if (authorization.kind !== 'session') {
      requireVerifier(authorization.verifier, 'Registration grant');
      requireVerifier(input.nextRecoveryVerifier ?? '', 'Next recovery verifier');
    }
    return this.store.db.runTransaction(async (tx) => {
      await this.consumeChallenge(tx, input.challenge);
      const stateSnapshot = await tx.get(this.stateRef());
      const state = FirestoreOwnerAuthRepository.decodeState(stateSnapshot.data());
      const current = FirestoreOwnerAuthRepository.publicState(state);
      const existing = await tx.get(this.passkeyRef(passkey.id));
      if (existing.exists) throw new OwnerAuthRejectedError('passkey_exists');
      const active = await tx.get(
        this.store
          .collection('ownerPasskeys')
          .where('revokedAt', '==', null)
          .limit(MAX_OWNER_PASSKEYS + 1),
      );
      let claim: ClaimDoc | null = null;
      if (authorization.kind === 'claim')
        claim = await this.readClaim((ref) => tx.get(ref), authorization.verifier);
      const now = this.store.now();

      let generation = current.sessionGeneration;
      const nextState: StateDoc = { ...state, updatedAt: now };
      if (authorization.kind === 'claim') {
        if (claim?.grant === 'claim') {
          if (current.claimed) throw new OwnerAuthRejectedError('claim_invalid');
          nextState.claimedAt = now;
          generation = Math.max(1, generation);
        } else {
          if (!current.claimed) throw new OwnerAuthRejectedError('claim_invalid');
          // Cloud-owner recovery signs out every existing browser.
          generation += 1;
        }
        nextState.recoveryVerifier = input.nextRecoveryVerifier;
      } else if (authorization.kind === 'recovery-code') {
        if (!current.claimed || state.recoveryVerifier !== authorization.verifier)
          throw new OwnerAuthRejectedError('recovery_invalid');
        generation += 1;
        nextState.recoveryVerifier = input.nextRecoveryVerifier;
      } else {
        if (!current.claimed || authorization.generation !== current.sessionGeneration)
          throw new OwnerAuthRejectedError('session_revoked');
      }
      if (active.size >= MAX_OWNER_PASSKEYS) throw new OwnerAuthRejectedError('passkey_limit');
      nextState.sessionGeneration = generation;

      this.writeChallenge(tx, input.challenge, now);
      if (claim) tx.set(this.claimRef(), encodeRecord({ ...claim, consumedAt: now }));
      tx.set(this.stateRef(), encodeRecord(nextState));
      const record: OwnerPasskey = {
        id: passkey.id,
        publicKey: passkey.publicKey,
        counter: passkey.counter,
        transports: passkey.transports.filter((t) => /^[a-z-]{2,20}$/.test(t)).slice(0, 8),
        deviceType: passkey.deviceType === 'multiDevice' ? 'multiDevice' : 'singleDevice',
        backedUp: passkey.backedUp === true,
        label: cleanLabel(passkey.label, 'Passkey'),
        createdAt: now,
        lastUsedAt: now,
        revokedAt: null,
      };
      tx.create(this.passkeyRef(passkey.id), encodeRecord(record));
      return { sessionGeneration: generation };
    });
  }

  async getPasskey(id: string): Promise<OwnerPasskey | null> {
    if (!CREDENTIAL_ID.test(id)) return null;
    const snapshot = await this.passkeyRef(id).get();
    if (!snapshot.exists) return null;
    const passkey = decodeRecord<OwnerPasskey>(snapshot.data());
    return passkey.id === id ? passkey : null;
  }

  /** Commit a verified assertion: single-use challenge, live passkey, monotonic counter. */
  async recordLogin(input: {
    challenge: OwnerChallengeUse;
    credentialId: string;
    counter: number;
  }): Promise<{ sessionGeneration: number }> {
    if (!CREDENTIAL_ID.test(input.credentialId))
      throw new OwnerAuthRejectedError('passkey_unknown');
    return this.store.db.runTransaction(async (tx) => {
      await this.consumeChallenge(tx, input.challenge);
      const [stateSnapshot, passkeySnapshot] = await Promise.all([
        tx.get(this.stateRef()),
        tx.get(this.passkeyRef(input.credentialId)),
      ]);
      const state = FirestoreOwnerAuthRepository.publicState(
        FirestoreOwnerAuthRepository.decodeState(stateSnapshot.data()),
      );
      if (!state.claimed || !passkeySnapshot.exists)
        throw new OwnerAuthRejectedError('passkey_unknown');
      const passkey = decodeRecord<OwnerPasskey>(passkeySnapshot.data());
      if (passkey.id !== input.credentialId || passkey.revokedAt !== null)
        throw new OwnerAuthRejectedError('passkey_unknown');
      // Synced passkeys commonly report zero; any nonzero counter must advance.
      if ((input.counter !== 0 || passkey.counter !== 0) && input.counter <= passkey.counter)
        throw new OwnerAuthRejectedError('passkey_counter');
      const now = this.store.now();
      this.writeChallenge(tx, input.challenge, now);
      tx.update(this.passkeyRef(input.credentialId), { counter: input.counter, lastUsedAt: now });
      return { sessionGeneration: Math.max(1, state.sessionGeneration) };
    });
  }

  async listPasskeys(): Promise<OwnerPasskey[]> {
    const snapshot = await this.store
      .collection('ownerPasskeys')
      .limit(MAX_OWNER_PASSKEYS * 5)
      .get();
    return snapshot.docs
      .map((doc) => decodeRecord<OwnerPasskey>(doc.data()))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  }

  /** Revoke one passkey and every session. The last active passkey cannot be removed. */
  async revokePasskey(id: string, generation: number): Promise<void> {
    await this.store.db.runTransaction(async (tx) => {
      const stateSnapshot = await tx.get(this.stateRef());
      const state = FirestoreOwnerAuthRepository.decodeState(stateSnapshot.data());
      const current = FirestoreOwnerAuthRepository.publicState(state);
      if (!current.claimed || generation !== current.sessionGeneration)
        throw new OwnerAuthRejectedError('session_revoked');
      const snapshot = CREDENTIAL_ID.test(id) ? await tx.get(this.passkeyRef(id)) : null;
      if (!snapshot?.exists) throw new OwnerAuthRejectedError('passkey_unknown');
      const passkey = decodeRecord<OwnerPasskey>(snapshot.data());
      if (passkey.revokedAt !== null) throw new OwnerAuthRejectedError('passkey_unknown');
      const active = await tx.get(
        this.store.collection('ownerPasskeys').where('revokedAt', '==', null).limit(2),
      );
      if (active.size < 2) throw new OwnerAuthRejectedError('last_passkey');
      const now = this.store.now();
      tx.update(this.passkeyRef(id), { revokedAt: now });
      tx.set(
        this.stateRef(),
        encodeRecord({
          ...state,
          sessionGeneration: current.sessionGeneration + 1,
          updatedAt: now,
        }),
      );
    });
  }

  /** Sign out every browser session, including the caller's. */
  async revokeSessions(generation: number): Promise<void> {
    await this.store.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(this.stateRef());
      const state = FirestoreOwnerAuthRepository.decodeState(snapshot.data());
      const current = FirestoreOwnerAuthRepository.publicState(state);
      if (!current.claimed || generation !== current.sessionGeneration)
        throw new OwnerAuthRejectedError('session_revoked');
      tx.set(
        this.stateRef(),
        encodeRecord({
          ...state,
          sessionGeneration: current.sessionGeneration + 1,
          updatedAt: this.store.now(),
        }),
      );
    });
  }

  /** Replace the offline recovery code; the old code stops working immediately. */
  async rotateRecoveryCode(input: { verifier: string; generation: number }): Promise<void> {
    requireVerifier(input.verifier, 'Recovery verifier');
    await this.store.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(this.stateRef());
      const state = FirestoreOwnerAuthRepository.decodeState(snapshot.data());
      const current = FirestoreOwnerAuthRepository.publicState(state);
      if (!current.claimed || input.generation !== current.sessionGeneration)
        throw new OwnerAuthRejectedError('session_revoked');
      tx.set(
        this.stateRef(),
        encodeRecord({ ...state, recoveryVerifier: input.verifier, updatedAt: this.store.now() }),
      );
    });
  }

  async createDevice(input: {
    id: string;
    name: string;
    verifier: string;
    generation: number;
  }): Promise<OwnerDevice> {
    if (!DEVICE_ID.test(input.id)) throw new Error('Invalid device ID');
    requireVerifier(input.verifier, 'Device verifier');
    return this.store.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(this.stateRef());
      const current = FirestoreOwnerAuthRepository.publicState(
        FirestoreOwnerAuthRepository.decodeState(snapshot.data()),
      );
      if (!current.claimed || input.generation !== current.sessionGeneration)
        throw new OwnerAuthRejectedError('session_revoked');
      const active = await tx.get(
        this.store
          .collection('ownerDevices')
          .where('revokedAt', '==', null)
          .limit(MAX_OWNER_DEVICES + 1),
      );
      if (active.size >= MAX_OWNER_DEVICES) throw new OwnerAuthRejectedError('device_limit');
      const device: OwnerDevice = {
        id: input.id,
        name: cleanLabel(input.name, 'iPhone'),
        verifier: input.verifier,
        createdAt: this.store.now(),
        revokedAt: null,
      };
      tx.create(this.deviceRef(input.id), encodeRecord(device));
      return device;
    });
  }

  async getDevice(id: string): Promise<OwnerDevice | null> {
    if (!DEVICE_ID.test(id)) return null;
    const snapshot = await this.deviceRef(id).get();
    if (!snapshot.exists) return null;
    const device = decodeRecord<OwnerDevice>(snapshot.data());
    return device.id === id ? device : null;
  }

  async listDevices(): Promise<Omit<OwnerDevice, 'verifier'>[]> {
    const snapshot = await this.store
      .collection('ownerDevices')
      .limit(MAX_OWNER_DEVICES * 5)
      .get();
    return snapshot.docs
      .map((doc) => {
        const { verifier: _verifier, ...device } = decodeRecord<OwnerDevice>(doc.data());
        return device;
      })
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  }

  async revokeDevice(id: string, generation: number): Promise<void> {
    await this.store.db.runTransaction(async (tx) => {
      const stateSnapshot = await tx.get(this.stateRef());
      const current = FirestoreOwnerAuthRepository.publicState(
        FirestoreOwnerAuthRepository.decodeState(stateSnapshot.data()),
      );
      if (!current.claimed || generation !== current.sessionGeneration)
        throw new OwnerAuthRejectedError('session_revoked');
      const snapshot = DEVICE_ID.test(id) ? await tx.get(this.deviceRef(id)) : null;
      if (!snapshot?.exists) throw new OwnerAuthRejectedError('device_unknown');
      const device = decodeRecord<OwnerDevice>(snapshot.data());
      if (device.revokedAt !== null) return;
      tx.update(this.deviceRef(id), { revokedAt: this.store.now() });
    });
  }
}
