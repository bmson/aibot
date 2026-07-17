import { generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  oidcAudienceForPath,
  verifyGoogleServiceAccountToken,
  verifyInternalAuthorization,
} from './google-oidc.js';

const audience = 'https://agent.example.test';
const serviceAccount = 'assistant-invoker@example.iam.gserviceaccount.com';

async function signedToken(overrides: Record<string, unknown> = {}) {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const token = await new SignJWT({
    email: serviceAccount,
    email_verified: true,
    ...overrides,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer('https://accounts.google.com')
    .setAudience(audience)
    .setSubject('123456789')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
  return { token, publicKey };
}

describe('Google OIDC authorization', () => {
  it('binds an internal token audience to one route', () => {
    expect(oidcAudienceForPath(audience, '/internal/sweep')).toBe(
      'https://agent.example.test/internal/sweep',
    );
    expect(oidcAudienceForPath('', '/internal/sweep')).toBe('');
  });

  it('accepts the expected audience and verified service-account email', async () => {
    const { token, publicKey } = await signedToken();
    expect(
      await verifyGoogleServiceAccountToken(`Bearer ${token}`, {
        audience,
        serviceAccount,
        jwks: async () => publicKey,
      }),
    ).toBe(true);
  });

  it('rejects a token for a different service account or audience', async () => {
    const { token, publicKey } = await signedToken();
    const jwks = async () => publicKey;
    expect(
      await verifyGoogleServiceAccountToken(`Bearer ${token}`, {
        audience,
        serviceAccount: 'attacker@example.iam.gserviceaccount.com',
        jwks,
      }),
    ).toBe(false);
    expect(
      await verifyGoogleServiceAccountToken(`Bearer ${token}`, {
        audience: 'https://other.example.test',
        serviceAccount,
        jwks,
      }),
    ).toBe(false);
  });

  it('rejects an unverified email claim', async () => {
    const { token, publicKey } = await signedToken({ email_verified: false });
    expect(
      await verifyGoogleServiceAccountToken(`Bearer ${token}`, {
        audience,
        serviceAccount,
        jwks: async () => publicKey,
      }),
    ).toBe(false);
  });

  it('allows shared-secret auth only when explicitly configured', async () => {
    const base = {
      INTERNAL_API_SECRET: 'local-test-secret',
      INTERNAL_OIDC_AUDIENCE: '',
      INTERNAL_OIDC_SERVICE_ACCOUNT: '',
    } as const;

    expect(
      await verifyInternalAuthorization(`Bearer ${base.INTERNAL_API_SECRET}`, {
        ...base,
        INTERNAL_AUTH_MODE: 'shared-secret',
      }),
    ).toBe(true);
    expect(
      await verifyInternalAuthorization(`Bearer ${base.INTERNAL_API_SECRET}`, {
        ...base,
        INTERNAL_AUTH_MODE: 'oidc',
      }),
    ).toBe(false);
    expect(
      await verifyInternalAuthorization(
        `Bearer ${base.INTERNAL_API_SECRET}`,
        { ...base, INTERNAL_AUTH_MODE: 'shared-secret' },
        undefined,
        'production',
      ),
    ).toBe(false);
  });
});
