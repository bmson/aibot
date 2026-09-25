import {
  ownerAuthJson,
  ownerAuthRoute,
  ownerAuthService,
  readJsonBody,
  setOwnerSessionCookie,
} from '@/lib/owner-auth/runtime';

/** Discoverable-passkey sign-in. Options are stateless; verify consumes the challenge once. */
export function POST(request: Request) {
  return ownerAuthRoute(request, async () => {
    const body = await readJsonBody(request);
    const service = ownerAuthService();
    if (body.action === 'options') return ownerAuthJson(await service.loginOptions());
    if (body.action === 'verify') {
      const session = await service.finishLogin({
        challengeToken: body.challengeToken,
        response: body.response,
      });
      await setOwnerSessionCookie(session.token);
      return ownerAuthJson({ ok: true });
    }
    return ownerAuthJson({ error: 'action_invalid' }, 400);
  });
}
