import { createHash, timingSafeEqual } from 'node:crypto';
import type { Config } from '@assistant/config';
import { createRemoteJWKSet, type JWTVerifyGetKey, type JWTVerifyOptions, jwtVerify } from 'jose';

const googleJwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const googleIssuers = ['https://accounts.google.com', 'accounts.google.com'];

export function oidcAudienceForPath(baseUrl: string, requestPath: string): string {
  if (!baseUrl) return '';
  try {
    return new URL(requestPath, baseUrl).toString();
  } catch {
    return '';
  }
}

function bearerToken(authorization: string | undefined): string | null {
  if (!authorization?.startsWith('Bearer ')) return null;
  const token = authorization.slice(7).trim();
  return token || null;
}

/**
 * Verify both Google's signature and the service-account identity carried by
 * an ID token. Audience validation prevents a token minted for one callback
 * from being replayed against another service.
 */
export async function verifyGoogleServiceAccountToken(
  authorization: string | undefined,
  options: {
    audience: string;
    serviceAccount: string;
    jwks?: JWTVerifyGetKey;
  },
): Promise<boolean> {
  const token = bearerToken(authorization);
  if (!token || !options.audience || !options.serviceAccount) return false;

  const verifyOptions: JWTVerifyOptions = {
    algorithms: ['RS256'],
    issuer: googleIssuers,
    audience: options.audience,
  };
  try {
    const { payload } = await jwtVerify(token, options.jwks ?? googleJwks, verifyOptions);
    return payload.email_verified === true && payload.email === options.serviceAccount;
  } catch {
    return false;
  }
}

function secretsEqual(actual: string, expected: string): boolean {
  const actualDigest = createHash('sha256').update(actual).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

export async function verifyInternalAuthorization(
  authorization: string | undefined,
  config: Pick<
    Config,
    | 'INTERNAL_AUTH_MODE'
    | 'INTERNAL_API_SECRET'
    | 'INTERNAL_OIDC_AUDIENCE'
    | 'INTERNAL_OIDC_SERVICE_ACCOUNT'
  >,
  jwks?: JWTVerifyGetKey,
  nodeEnv = process.env.NODE_ENV,
): Promise<boolean> {
  if (config.INTERNAL_AUTH_MODE === 'shared-secret') {
    if (nodeEnv === 'production') return false;
    const token = bearerToken(authorization);
    return Boolean(
      token && config.INTERNAL_API_SECRET && secretsEqual(token, config.INTERNAL_API_SECRET),
    );
  }

  return verifyGoogleServiceAccountToken(authorization, {
    audience: config.INTERNAL_OIDC_AUDIENCE,
    serviceAccount: config.INTERNAL_OIDC_SERVICE_ACCOUNT,
    ...(jwks ? { jwks } : {}),
  });
}
