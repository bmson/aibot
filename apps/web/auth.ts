import { loadConfig } from '@assistant/config';
import { redirect, unauthorized } from 'next/navigation';
import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import { resolveAuthMode } from './auth-mode';

// loadConfig() side-loads the repo-root .env, so AUTH_* vars defined there are
// visible even though Next only reads apps/web/.env* files.
const config = loadConfig();

/**
 * google     — AUTH_GOOGLE_ID is set; real Google sign-in, allowlisted to the owner.
 * dev-bypass — explicitly enabled for development or loopback-only Docker; auth is skipped.
 * disabled   — auth is not configured; every request is rejected (401).
 */
export const authMode = resolveAuthMode({
  googleClientId: config.AUTH_GOOGLE_ID,
  devBypass: config.AUTH_DEV_BYPASS,
  localhostBypass: config.AUTH_LOCALHOST_BYPASS,
  authUrl: config.AUTH_URL,
  queueDriver: config.QUEUE_DRIVER,
  nodeEnv: process.env.NODE_ENV,
});

if (authMode === 'dev-bypass') {
  console.warn('[auth] explicit local bypass enabled — owner authentication is disabled');
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google],
  session: { strategy: 'jwt' },
  callbacks: {
    signIn({ profile }) {
      // Belt-and-suspenders: with Google as the sole IdP the email namespace is
      // Google's, but require the verified flag so an unverified-email account
      // can never match the owner address. The typed claim is a boolean, so an
      // explicit === true is exact and cannot be spoofed by a string value.
      return profile?.email === config.OWNER_EMAIL && profile?.email_verified === true;
    },
  },
});

export interface OwnerSession {
  user: { email: string; name?: string | null };
}

/**
 * Returns the owner session, or null when the request is not authenticated.
 * Used by API routes (return 401 yourself) and by requireOwner() for pages.
 */
export async function isAuthed(): Promise<OwnerSession | null> {
  if (authMode === 'dev-bypass') {
    return { user: { email: config.OWNER_EMAIL, name: 'Owner (dev)' } };
  }
  if (authMode === 'disabled') return null;
  const session = await auth();
  if (session?.user?.email === config.OWNER_EMAIL) {
    return { user: { email: session.user.email, name: session.user.name } };
  }
  return null;
}

/**
 * Page guard: redirects to the sign-in page when Google auth is configured,
 * renders the 401 page when auth is unconfigured in production.
 */
export async function requireOwner(): Promise<OwnerSession> {
  const session = await isAuthed();
  if (session) return session;
  if (authMode === 'google') redirect('/api/auth/signin');
  unauthorized();
}
