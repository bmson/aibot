import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  type FirestoreOwnerAuthRepository,
  generateOwnerSecret,
  generateRecoveryCode,
  normalizeRecoveryCode,
  OwnerAuthRejectedError,
  type OwnerRegistrationAuthorization,
  ownerSecretVerifier,
} from '@assistant/firestore';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import {
  OWNER_CHALLENGE_TTL_SECONDS,
  OWNER_SESSION_TTL_SECONDS,
  type OwnerSessionClaims,
  signToken,
  verifyToken,
} from './tokens';

export type OwnerAuthStore = Pick<
  FirestoreOwnerAuthRepository,
  | 'state'
  | 'checkClaim'
  | 'checkRecoveryCode'
  | 'registerPasskey'
  | 'getPasskey'
  | 'recordLogin'
  | 'listPasskeys'
  | 'revokePasskey'
  | 'revokeSessions'
  | 'rotateRecoveryCode'
  | 'createDevice'
  | 'getDevice'
  | 'listDevices'
  | 'revokeDevice'
>;

export interface WebAuthnFunctions {
  generateRegistrationOptions: typeof generateRegistrationOptions;
  verifyRegistrationResponse: typeof verifyRegistrationResponse;
  generateAuthenticationOptions: typeof generateAuthenticationOptions;
  verifyAuthenticationResponse: typeof verifyAuthenticationResponse;
}

const defaultWebAuthn: WebAuthnFunctions = {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
};

type ChallengeClaims =
  | { purpose: 'register'; challenge: string; grant: OwnerRegistrationAuthorization; exp: number }
  | { purpose: 'login'; challenge: string; exp: number };
type UnsignedChallenge = ChallengeClaims extends infer T
  ? T extends ChallengeClaims
    ? Omit<T, 'exp'>
    : never
  : never;

/** Raised for any rejected owner-auth input; routes map it to a generic 4xx. */
export class OwnerAuthInputError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 409,
    readonly code: string,
  ) {
    super(code);
    this.name = 'OwnerAuthInputError';
  }
}

const DEVICE_TOKEN = /^asd1_([a-z0-9]{24})_([A-Za-z0-9_-]{43})$/;

export class OwnerPasskeyService {
  private readonly webauthn: WebAuthnFunctions;
  private readonly now: () => Date;

  constructor(
    private readonly options: {
      store: OwnerAuthStore;
      secret: string;
      origin: string;
      rpId: string;
      rpName: string;
      /** Stable per-installation user handle; never the owner email. */
      installationId: string;
      ownerName: string;
      now?: () => Date;
      webauthn?: WebAuthnFunctions;
    },
  ) {
    this.webauthn = options.webauthn ?? defaultWebAuthn;
    this.now = options.now ?? (() => new Date());
  }

  private seconds(): number {
    return Math.floor(this.now().getTime() / 1000);
  }

  private userId(): Uint8Array<ArrayBuffer> {
    const digest = createHash('sha256')
      .update(`assistant-owner-user:${this.options.installationId}`)
      .digest();
    return new Uint8Array(digest.subarray(0, 16));
  }

  private challengeToken(claims: UnsignedChallenge): string {
    return signToken(this.options.secret, 'owner-challenge-v1', {
      ...claims,
      exp: this.seconds() + OWNER_CHALLENGE_TTL_SECONDS,
    } as ChallengeClaims);
  }

  private readChallenge(token: unknown, purpose: ChallengeClaims['purpose']): ChallengeClaims {
    const claims = verifyToken<ChallengeClaims>(
      this.options.secret,
      'owner-challenge-v1',
      typeof token === 'string' ? token : null,
      this.now(),
    );
    if (!claims || claims.purpose !== purpose || typeof claims.challenge !== 'string')
      throw new OwnerAuthInputError(400, 'challenge_invalid');
    return claims;
  }

  private challengeUse(claims: ChallengeClaims) {
    return {
      key: createHash('sha256').update(claims.challenge).digest('hex'),
      expiresAt: new Date(claims.exp * 1000),
    };
  }

  issueSession(generation: number): { token: string; claims: OwnerSessionClaims } {
    const iat = this.seconds();
    const claims: OwnerSessionClaims = {
      sid: randomBytes(12).toString('base64url'),
      gen: generation,
      iat,
      exp: iat + OWNER_SESSION_TTL_SECONDS,
    };
    return { token: signToken(this.options.secret, 'owner-session-v1', claims), claims };
  }

  /** Signature and expiry only; callers must also compare `gen` with stored state. */
  readSession(token: string | undefined | null): OwnerSessionClaims | null {
    const claims = verifyToken<OwnerSessionClaims>(
      this.options.secret,
      'owner-session-v1',
      token,
      this.now(),
    );
    if (!claims || !Number.isSafeInteger(claims.gen) || claims.gen < 1) return null;
    return claims;
  }

  private async registrationOptions(grant: OwnerRegistrationAuthorization) {
    const existing =
      grant.kind === 'claim' && (await this.options.store.state()).claimed === false
        ? []
        : (await this.options.store.listPasskeys()).filter((key) => key.revokedAt === null);
    const options = await this.webauthn.generateRegistrationOptions({
      rpName: this.options.rpName,
      rpID: this.options.rpId,
      userName: this.options.ownerName,
      userDisplayName: this.options.ownerName,
      userID: this.userId(),
      attestationType: 'none',
      timeout: OWNER_CHALLENGE_TTL_SECONDS * 1000,
      excludeCredentials: existing.map((key) => ({ id: key.id, transports: key.transports })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    return {
      options,
      challengeToken: this.challengeToken({
        purpose: 'register',
        challenge: options.challenge,
        grant,
      }),
    };
  }

  private async rejectAs<T>(promise: Promise<T>, status: 400 | 401 | 403 | 409): Promise<T> {
    try {
      return await promise;
    } catch (error) {
      if (error instanceof OwnerAuthRejectedError)
        throw new OwnerAuthInputError(status, error.code);
      throw error;
    }
  }

  /** Setup link: the claim code comes from the installer and is never stored in plain text. */
  async claimOptions(code: unknown) {
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(code))
      throw new OwnerAuthInputError(403, 'claim_invalid');
    const verifier = ownerSecretVerifier('claim', code);
    const grant = await this.rejectAs(this.options.store.checkClaim(verifier), 403);
    return { grant, ...(await this.registrationOptions({ kind: 'claim', verifier })) };
  }

  async recoveryOptions(code: unknown) {
    if (typeof code !== 'string' || code.length > 64)
      throw new OwnerAuthInputError(403, 'recovery_invalid');
    const normalized = normalizeRecoveryCode(code);
    if (!/^[0-9A-Z]{25}$/.test(normalized)) throw new OwnerAuthInputError(403, 'recovery_invalid');
    const verifier = ownerSecretVerifier('recovery', normalized);
    await this.rejectAs(this.options.store.checkRecoveryCode(verifier), 403);
    return this.registrationOptions({ kind: 'recovery-code', verifier });
  }

  async addPasskeyOptions(session: OwnerSessionClaims) {
    return this.registrationOptions({ kind: 'session', generation: session.gen });
  }

  /**
   * Verify a new passkey. Claim and recovery grants return a fresh session and
   * a new offline recovery code, which the caller must show exactly once.
   */
  async finishRegistration(input: {
    challengeToken: unknown;
    response: unknown;
    label?: unknown;
    session?: OwnerSessionClaims | null;
  }): Promise<{ session?: { token: string; claims: OwnerSessionClaims }; recoveryCode?: string }> {
    const claims = this.readChallenge(input.challengeToken, 'register');
    if (claims.purpose !== 'register') throw new OwnerAuthInputError(400, 'challenge_invalid');
    if (
      claims.grant.kind === 'session' &&
      (!input.session || input.session.gen !== claims.grant.generation)
    )
      throw new OwnerAuthInputError(401, 'session_required');
    let verification: Awaited<ReturnType<WebAuthnFunctions['verifyRegistrationResponse']>>;
    try {
      verification = await this.webauthn.verifyRegistrationResponse({
        response: input.response as Parameters<
          WebAuthnFunctions['verifyRegistrationResponse']
        >[0]['response'],
        expectedChallenge: claims.challenge,
        expectedOrigin: this.options.origin,
        expectedRPID: this.options.rpId,
        requireUserVerification: true,
      });
    } catch {
      throw new OwnerAuthInputError(400, 'registration_invalid');
    }
    if (!verification.verified) throw new OwnerAuthInputError(400, 'registration_invalid');
    const info = verification.registrationInfo;
    const recoveryCode = claims.grant.kind === 'session' ? undefined : generateRecoveryCode();
    const result = await this.rejectAs(
      this.options.store.registerPasskey({
        challenge: this.challengeUse(claims),
        authorization: claims.grant,
        passkey: {
          id: info.credential.id,
          publicKey: Buffer.from(info.credential.publicKey).toString('base64url'),
          counter: info.credential.counter,
          transports: info.credential.transports ?? [],
          deviceType: info.credentialDeviceType,
          backedUp: info.credentialBackedUp,
          label: typeof input.label === 'string' ? input.label : 'Passkey',
        },
        ...(recoveryCode
          ? {
              nextRecoveryVerifier: ownerSecretVerifier(
                'recovery',
                normalizeRecoveryCode(recoveryCode),
              ),
            }
          : {}),
      }),
      409,
    );
    if (claims.grant.kind === 'session') return {};
    return { session: this.issueSession(result.sessionGeneration), recoveryCode };
  }

  async loginOptions() {
    const options = await this.webauthn.generateAuthenticationOptions({
      rpID: this.options.rpId,
      userVerification: 'required',
      timeout: OWNER_CHALLENGE_TTL_SECONDS * 1000,
    });
    return {
      options,
      challengeToken: this.challengeToken({ purpose: 'login', challenge: options.challenge }),
    };
  }

  async finishLogin(input: { challengeToken: unknown; response: unknown }) {
    const claims = this.readChallenge(input.challengeToken, 'login');
    const response = input.response as Parameters<
      WebAuthnFunctions['verifyAuthenticationResponse']
    >[0]['response'];
    const credentialId = typeof response?.id === 'string' ? response.id : '';
    const passkey = await this.options.store.getPasskey(credentialId);
    if (!passkey || passkey.revokedAt !== null)
      throw new OwnerAuthInputError(401, 'passkey_unknown');
    let verification: Awaited<ReturnType<WebAuthnFunctions['verifyAuthenticationResponse']>>;
    try {
      verification = await this.webauthn.verifyAuthenticationResponse({
        response,
        expectedChallenge: claims.challenge,
        expectedOrigin: this.options.origin,
        expectedRPID: this.options.rpId,
        requireUserVerification: true,
        credential: {
          id: passkey.id,
          publicKey: new Uint8Array(Buffer.from(passkey.publicKey, 'base64url')),
          counter: passkey.counter,
          transports: passkey.transports as never,
        },
      });
    } catch {
      throw new OwnerAuthInputError(401, 'assertion_invalid');
    }
    if (!verification.verified) throw new OwnerAuthInputError(401, 'assertion_invalid');
    const result = await this.rejectAs(
      this.options.store.recordLogin({
        challenge: this.challengeUse(claims),
        credentialId: passkey.id,
        counter: verification.authenticationInfo.newCounter,
      }),
      401,
    );
    return this.issueSession(result.sessionGeneration);
  }

  async rotateRecoveryCode(session: OwnerSessionClaims): Promise<string> {
    const code = generateRecoveryCode();
    await this.rejectAs(
      this.options.store.rotateRecoveryCode({
        verifier: ownerSecretVerifier('recovery', normalizeRecoveryCode(code)),
        generation: session.gen,
      }),
      401,
    );
    return code;
  }

  /** A revocable per-device bearer credential for the native app, shown once. */
  async createDevice(session: OwnerSessionClaims, name: unknown): Promise<string> {
    const id = randomBytes(12).toString('hex');
    const secret = generateOwnerSecret();
    await this.rejectAs(
      this.options.store.createDevice({
        id,
        name: typeof name === 'string' ? name : 'iPhone',
        verifier: ownerSecretVerifier('device', secret),
        generation: session.gen,
      }),
      409,
    );
    return `asd1_${id}_${secret}`;
  }

  /** Returns the device ID for a live per-device credential, or null. */
  async verifyDeviceToken(token: string): Promise<string | null> {
    const match = DEVICE_TOKEN.exec(token);
    if (!match?.[1] || !match[2]) return null;
    const device = await this.options.store.getDevice(match[1]);
    if (!device || device.revokedAt !== null) return null;
    const expected = Buffer.from(device.verifier, 'hex');
    const actual = Buffer.from(ownerSecretVerifier('device', match[2]), 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual)
      ? device.id
      : null;
  }
}
