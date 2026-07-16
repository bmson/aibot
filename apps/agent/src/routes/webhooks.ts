import { loadConfig, recordBrowserJobResult } from '@assistant/core';
import { validateTwilioSignature } from '@assistant/tools';
import { Hono } from 'hono';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { buildDeps } from '../deps.js';
import { syncMailbox } from '../email-sync.js';
import { handleInboundSms } from '../sms-channel.js';

/**
 * External ingress. Every route authenticates its caller before anything else:
 * Pub/Sub push → Google-signed OIDC JWT; Twilio → X-Twilio-Signature (Phase 4).
 */
export const webhooks = new Hono();

const googleJwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

webhooks.post('/gmail/pubsub', async (c) => {
  const config = loadConfig();
  const auth = c.req.header('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return c.json({ error: 'missing token' }, 401);

  try {
    await jwtVerify(token, googleJwks, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: `${config.PUBLIC_URL}/webhooks/gmail/pubsub`,
    });
  } catch {
    return c.json({ error: 'invalid token' }, 403);
  }

  // The push payload is only a poke — history.list is the source of truth.
  // Ack fast (2xx) regardless of sync outcome; failures retry via the poller.
  const deps = buildDeps();
  syncMailbox(deps).catch((err) => console.error('pubsub-triggered sync failed', err));
  return c.json({ ok: true });
});

/**
 * Browser-job result callback. Auth is the per-launch one-shot token minted by
 * browser.execute and checkpointed in the task state — the job carries no
 * shared secrets, so a leaked job env can wake exactly one task, once.
 */
webhooks.post('/browser/callback', async (c) => {
  const body = await c.req
    .json<{ taskId?: string; token?: string; result?: Record<string, unknown> }>()
    .catch(() => null);
  if (!body?.taskId || !body?.token) return c.json({ error: 'bad request' }, 400);

  const deps = buildDeps();
  const outcome = await recordBrowserJobResult(deps.db, {
    taskId: body.taskId,
    token: body.token,
    result: body.result ?? { ok: false, error: 'job reported no result' },
  });
  if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status);
  return c.json({ ok: true });
});

webhooks.post('/twilio/sms', async (c) => {
  const config = loadConfig();
  if (!config.TWILIO_AUTH_TOKEN) return c.text('Twilio not configured', 501);

  const form = await c.req.parseBody();
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(form)) if (typeof v === 'string') params[k] = v;

  const valid = validateTwilioSignature({
    authToken: config.TWILIO_AUTH_TOKEN,
    url: `${config.PUBLIC_URL}/webhooks/twilio/sms`,
    params,
    signature: c.req.header('x-twilio-signature') ?? '',
  });
  if (!valid) return c.text('invalid signature', 403);

  const deps = buildDeps();
  const handled = await handleInboundSms(deps, {
    messageSid: params.MessageSid ?? '',
    from: params.From ?? '',
    to: params.To ?? '',
    body: params.Body ?? '',
  });

  // Approval replies get a synchronous TwiML ack; normal turns reply async
  // via the executor's deliverFinal hook (long model turns vs webhook timeout).
  if (handled.kind === 'approval') {
    const ack = handled.resolved
      ? `✓ ${handled.shortCode} ${handled.decision}`
      : `${handled.shortCode} not found or already resolved`;
    return c.text(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${ack}</Message></Response>`,
      200,
      { 'content-type': 'text/xml' },
    );
  }
  return c.text('<?xml version="1.0" encoding="UTF-8"?><Response/>', 200, {
    'content-type': 'text/xml',
  });
});
