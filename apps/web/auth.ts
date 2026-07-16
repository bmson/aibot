import { loadConfig } from '@assistant/core/config';
import { redirect, unauthorized } from 'next/navigation';
import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';

// loadConfig() side-loads the repo-root .env, so AUTH_* vars defined there are
// visible even though Next only reads apps/web/.env* files.
const config = loadConfig();

export type AuthMode = 'google' | 'dev-bypass' | 'disabled';

/**
 * google     — AUTH_GOOGLE_ID is set; real Google sign-in, allowlisted to the owner.
 * dev-bypass — no AUTH_GOOGLE_ID outside production; auth is skipped entirely.
 * disabled   — no AUTH_GOOGLE_ID in production; every request is rejected (401).
 */
export const authMode: AuthMode = process.env.AUTH_GOOGLE_ID
  ? 'google'
  : process.env.NODE_ENV !== 'production'
    ? 'dev-bypass'
    : 'disabled';

if (authMode === 'dev-bypass') {
  console.warn('[auth] dev mode — auth disabled (set AUTH_GOOGLE_ID to enable Google sign-in)');
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google],
  session: { strategy: 'jwt' },
  callbacks: {
    signIn({ profile }) {
      return profile?.email === config.OWNER_EMAIL;
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
