import {
  forgetOwnerAuthState,
  ownerAuthJson,
  ownerAuthRoute,
  ownerAuthService,
  readJsonBody,
  setOwnerSessionCookie,
} from '@/lib/owner-auth/runtime';

/**
 * Setup-link claim. `options` checks the single-use claim code from the
 * installer; `verify` registers the first passkey, consumes the claim, and
 * returns the offline recovery code exactly once.
 */
export function POST(request: Request) {
  return ownerAuthRoute(request, async () => {
    const body = await readJsonBody(request);
    const service = ownerAuthService();
    if (body.action === 'options') {
      const { grant, options, challengeToken } = await service.claimOptions(body.code);
      return ownerAuthJson({ grant, options, challengeToken });
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
