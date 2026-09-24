import {
  currentOwnerSession,
  ownerAuthJson,
  ownerAuthRoute,
  ownerAuthService,
} from '@/lib/owner-auth/runtime';

/** Replace the offline recovery code; the new code is returned once. */
export function POST(request: Request) {
  return ownerAuthRoute(request, async () => {
    const session = await currentOwnerSession();
    if (!session) return ownerAuthJson({ error: 'unauthorized' }, 401);
    const recoveryCode = await ownerAuthService().rotateRecoveryCode(session);
    return ownerAuthJson({ recoveryCode });
  });
}
