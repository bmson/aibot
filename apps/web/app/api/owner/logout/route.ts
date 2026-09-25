import {
  clearOwnerSessionCookie,
  currentOwnerSession,
  forgetOwnerAuthState,
  ownerAuthJson,
  ownerAuthRepository,
  ownerAuthRoute,
  readJsonBody,
} from '@/lib/owner-auth/runtime';

/** Sign out this browser, or with `{ "everywhere": true }` every owner session. */
export function POST(request: Request) {
  return ownerAuthRoute(request, async () => {
    const body = await readJsonBody(request);
    if (body.everywhere === true) {
      const session = await currentOwnerSession();
      if (!session) return ownerAuthJson({ error: 'unauthorized' }, 401);
      await ownerAuthRepository().revokeSessions(session.gen);
      forgetOwnerAuthState();
    }
    await clearOwnerSessionCookie();
    return ownerAuthJson({ ok: true });
  });
}
