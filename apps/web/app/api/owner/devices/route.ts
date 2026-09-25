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

/** Per-device native app credentials (never including verifiers). */
export function GET(request: Request) {
  return ownerAuthRoute(request, async () => {
    if (!(await currentOwnerSession())) return ownerAuthJson({ error: 'unauthorized' }, 401);
    return ownerAuthJson({ devices: await ownerAuthRepository().listDevices() });
  });
}

/** Issue a new device key. It is shown once; only its verifier is stored. */
export function POST(request: Request) {
  return ownerAuthRoute(request, async () => {
    const session = await currentOwnerSession();
    if (!session) return ownerAuthJson({ error: 'unauthorized' }, 401);
    const body = await readJsonBody(request);
    const token = await ownerAuthService().createDevice(session, body.name);
    return ownerAuthJson({ token });
  });
}

export function DELETE(request: Request) {
  return ownerAuthRoute(request, async () => {
    const session = await currentOwnerSession();
    if (!session) return ownerAuthJson({ error: 'unauthorized' }, 401);
    const id = new URL(request.url).searchParams.get('id') ?? '';
    try {
      await ownerAuthRepository().revokeDevice(id, session.gen);
    } catch (error) {
      if (error instanceof OwnerAuthRejectedError) throw new OwnerAuthInputError(400, error.code);
      throw error;
    }
    forgetOwnerAuthState();
    return ownerAuthJson({ ok: true });
  });
}
