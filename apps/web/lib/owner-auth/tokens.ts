import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/**
 * Compact HMAC-signed tokens for owner sessions and WebAuthn challenges. Each
 * use has its own HKDF-derived key so a challenge token can never be replayed
 * as a session cookie (or the reverse).
 */
export type TokenUse = 'owner-session-v1' | 'owner-challenge-v1';

function keyFor(secret: string, use: TokenUse): Buffer {
  if (secret.length < 32) throw new Error('Owner token secret is too short');
  return Buffer.from(hkdfSync('sha256', secret, 'assistant-owner-auth', use, 32));
}

export function signToken(secret: string, use: TokenUse, payload: { exp: number }): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const mac = createHmac('sha256', keyFor(secret, use)).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifyToken<T extends { exp: number }>(
  secret: string,
  use: TokenUse,
  token: string | undefined | null,
  now: Date,
): T | null {
  if (!token || token.length > 4096) return null;
  const [body, mac, extra] = token.split('.');
  if (!body || !mac || extra !== undefined) return null;
  const expected = createHmac('sha256', keyFor(secret, use)).update(body).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(mac, 'base64url');
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  const exp = (payload as { exp?: unknown }).exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp * 1000 <= now.getTime()) return null;
  return payload as T;
}

export interface OwnerSessionClaims {
  /** Random session identifier, for logs and future per-session revocation. */
  sid: string;
  /** Must equal the stored owner session generation to be accepted. */
  gen: number;
  iat: number;
  exp: number;
}

export const OWNER_SESSION_TTL_SECONDS = 14 * 24 * 3600;
export const OWNER_CHALLENGE_TTL_SECONDS = 5 * 60;

/** `__Host-` binds the cookie to this exact origin; it requires HTTPS. */
export function ownerSessionCookieName(origin: string): string {
  return origin.startsWith('https://') ? '__Host-assistant-owner' : 'assistant-owner';
}
