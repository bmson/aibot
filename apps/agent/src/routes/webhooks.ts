import { loadConfig, recordBrowserJobResult } from '@assistant/core';
import { validateTwilioSignature } from '@assistant/tools';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { recordCanaryBrowserResult } from '../canaries.js';
import { buildDeps } from '../deps.js';
import { syncMailbox } from '../email-sync.js';
import { verifyGoogleServiceAccountToken } from '../google-oidc.js';
import { handleInboundSms } from '../sms-channel.js';

/**
 * External ingress. Every route authenticates its caller before anything else:
 * Pub/Sub push → Google-signed OIDC JWT; Twilio → X-Twilio-Signature (Phase 4).
 */
export const webhooks = new Hono();

// These routes are internet-facing. Reject oversized bodies while they are
// streaming, before JSON/form parsing can become a memory-denial vector.
webhooks.use(
  '*',
  bodyLimit({
    maxSize: 512 * 1024,
    onError: (c) => c.json({ error: 'request body too large' }, 413),
  }),
);

webhooks.post('/gmail/pubsub', async (c) => {
  const config = loadConfig();
  const authorization = c.req.header('authorization');
  if (!authorization) return c.json({ error: 'missing token' }, 401);
  if (
    !(await verifyGoogleServiceAccountToken(authorization, {
      audience: `${config.PUBLIC_URL}/webhooks/gmail/pubsub`,
      serviceAccount: config.GMAIL_PUSH_SERVICE_ACCOUNT,
    }))
  ) {
    return c.json({ error: 'invalid token' }, 403);
  }

  // The push payload is only a poke — history.list is the source of truth.
  // Acknowledge only after the durable history cursor advances. Pub/Sub retries
  // a non-2xx response, so a process crash or transient API failure loses no poke.
  const deps = buildDeps();
  try {
    await syncMailbox(deps);
  } catch (error) {
    console.error('pubsub-triggered sync failed', error);
    return c.json({ error: 'mailbox sync failed' }, 503);
  }
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

/** Dedicated one-shot callback for browser canaries; no task/workflow state is exposed. */
webhooks.post('/canaries/browser', async (c) => {
  const body = await c.req
    .json<{ taskId?: string; token?: string; result?: unknown }>()
    .catch(() => null);
  if (
    !body?.taskId ||
    !body.token ||
    !body.result ||
    typeof body.result !== 'object' ||
    Array.isArray(body.result)
  ) {
    return c.json({ error: 'bad request' }, 400);
  }
  const outcome = await recordCanaryBrowserResult(buildDeps().db, {
    runId: body.taskId,
    token: body.token,
    result: body.result as Record<string, unknown>,
  });
  if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status);
  return c.json({ ok: true, duplicate: outcome.duplicate });
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

  // Avoid an unmetered, billable TwiML reply. Normal task replies and approval
  // notifications use the budget-reserved delivery path.
  void handled;
  return c.text('<?xml version="1.0" encoding="UTF-8"?><Response/>', 200, {
    'content-type': 'text/xml',
  });
});
