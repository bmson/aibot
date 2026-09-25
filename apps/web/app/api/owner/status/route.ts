import { ownerAuthJson, ownerAuthRoute, ownerAuthState } from '@/lib/owner-auth/runtime';

export const dynamic = 'force-dynamic';

/**
 * Public claim status for the setup page and the installer's verify step.
 * It reveals only whether an owner passkey exists — no counts or identities.
 */
export function GET(request: Request) {
  return ownerAuthRoute(request, async () => {
    const state = await ownerAuthState(true);
    return ownerAuthJson({ mode: 'passkey', claimed: state.claimed });
  });
}
