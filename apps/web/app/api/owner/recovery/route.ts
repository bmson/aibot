import {
  forgetOwnerAuthState,
  ownerAuthJson,
  ownerAuthRoute,
  ownerAuthService,
  readJsonBody,
  setOwnerSessionCookie,
} from '@/lib/owner-auth/runtime';

/**
 * Offline recovery: the saved recovery code authorizes one new passkey. The
 * code is replaced, and every other browser session is signed out.
 */
export function POST(request: Request) {
  return ownerAuthRoute(request, async () => {
    const body = await readJsonBody(request);
    const service = ownerAuthService();
    if (body.action === 'options') {
      const { options, challengeToken } = await service.recoveryOptions(body.code);
      return ownerAuthJson({ options, challengeToken });
    }
    if (body.action === 'verify') {
      const result = await service.finishRegistration({
        challengeToken: body.challengeToken,
        response: body.response,
        label: body.label,
      });
      forgetOwnerAuthState();
      if (result.session) await setOwnerSessionCookie(result.session.token);
      return ownerAuthJson({ ok: true, recoveryCode: result.recoveryCode });
    }
    return ownerAuthJson({ error: 'action_invalid' }, 400);
  });
}
