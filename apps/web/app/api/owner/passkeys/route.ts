import { OwnerAuthRejectedError } from '@assistant/firestore';
import {
  currentOwnerSession,
  forgetOwnerAuthState,
  ownerAuthJson,
  ownerAuthRepository,
  ownerAuthRoute,
  ownerAuthService,
  readJsonBody,
} from '@/lib/owner-auth/runtime';
import { OwnerAuthInputError } from '@/lib/owner-auth/service';

/** List the owner's passkeys without public-key material. */
export function GET(request: Request) {
  return ownerAuthRoute(request, async () => {
    if (!(await currentOwnerSession())) return ownerAuthJson({ error: 'unauthorized' }, 401);
    const passkeys = await ownerAuthRepository().listPasskeys();
    return ownerAuthJson({
      passkeys: passkeys.map(({ publicKey: _publicKey, counter: _counter, ...key }) => key),
    });
  });
}

/** Add another passkey from a live session (a second device or a backup key). */
export function POST(request: Request) {
  return ownerAuthRoute(request, async () => {
    const session = await currentOwnerSession();
    if (!session) return ownerAuthJson({ error: 'unauthorized' }, 401);
    const body = await readJsonBody(request);
    const service = ownerAuthService();
    if (body.action === 'options') return ownerAuthJson(await service.addPasskeyOptions(session));
    if (body.action === 'verify') {
      await service.finishRegistration({
        challengeToken: body.challengeToken,
        response: body.response,
        label: body.label,
        session,
      });
      return ownerAuthJson({ ok: true });
    }
    return ownerAuthJson({ error: 'action_invalid' }, 400);
  });
}

/** Revoke one passkey. Every session is signed out; the last passkey is kept. */
export function DELETE(request: Request) {
  return ownerAuthRoute(request, async () => {
    const session = await currentOwnerSession();
    if (!session) return ownerAuthJson({ error: 'unauthorized' }, 401);
    const id = new URL(request.url).searchParams.get('id') ?? '';
    try {
      await ownerAuthRepository().revokePasskey(id, session.gen);
    } catch (error) {
      if (error instanceof OwnerAuthRejectedError)
        throw new OwnerAuthInputError(error.code === 'last_passkey' ? 409 : 400, error.code);
      throw error;
    }
    forgetOwnerAuthState();
    return ownerAuthJson({ ok: true });
  });
}
