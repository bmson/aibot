import { isModuleEnabled, loadConfig } from '@assistant/config';
import {
  getAgent,
  LocationPingSchema,
  locationPingFresh,
  recordBrowserJobResult,
  recordCodeJobResult,
  recordDocumentProcessorResult,
  recordLocationPing,
  verifyLocationSignature,
} from '@assistant/core';
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
  if (!isModuleEnabled(config, 'google')) return c.json({ error: 'google module disabled' }, 404);
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
  if (!isModuleEnabled(loadConfig(), 'browser')) {
    return c.json({ error: 'browser module disabled' }, 404);
  }
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

/**
 * Code-job result callback (Phase 13). Same one-shot-token auth as the browser
 * callback: the per-launch token minted by code.execute and checkpointed in the
 * task state is the only credential the credential-free job carries.
 */
webhooks.post('/code/callback', async (c) => {
  if (!isModuleEnabled(loadConfig(), 'code')) {
    return c.json({ error: 'code module disabled' }, 404);
  }
  const body = await c.req
    .json<{ taskId?: string; token?: string; result?: Record<string, unknown> }>()
    .catch(() => null);
  if (!body?.taskId || !body?.token) return c.json({ error: 'bad request' }, 400);

  const deps = buildDeps();
  const outcome = await recordCodeJobResult(deps.db, {
    taskId: body.taskId,
    token: body.token,
    result: body.result ?? { ok: false, error: 'job reported no result' },
  });
  if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status);
  return c.json({ ok: true });
});

/**
 * Document-processor result callback (Phase 14). Same one-shot-token auth as the
 * code/browser callbacks, but keyed on the document row rather than a task: the
 * per-launch token minted by the processor sweep and checkpointed on the
 * `documents` row is the only credential the credential-free worker carries.
 */
webhooks.post('/document/callback', async (c) => {
  if (!isModuleEnabled(loadConfig(), 'documents')) {
    return c.json({ error: 'documents module disabled' }, 404);
  }
  const body = await c.req
    .json<{
      documentId?: string;
      token?: string;
      result?: { ok?: boolean; kind?: string; chars?: number; error?: string };
    }>()
    .catch(() => null);
  if (!body?.documentId || !body?.token) return c.json({ error: 'bad request' }, 400);

  const r = body.result;
  const deps = buildDeps();
  const outcome = await recordDocumentProcessorResult(deps.db, {
    documentId: body.documentId,
    token: body.token,
    result: r
      ? { ok: r.ok === true, kind: r.kind, chars: r.chars, error: r.error }
      : { ok: false, error: 'job reported no result' },
  });
  if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status);
  return c.json({ ok: true });
});

/**
 * Owner location ping (Phase 15). Authenticated by an HMAC-SHA256 signature
 * (hex, `X-Signature` header) over the exact raw body, keyed by the shared
 * LOCATION_PING_SECRET the owner's Shortcut holds. An unsigned or forged ping
 * is rejected 403; ingest is off entirely when no secret is configured.
 */
webhooks.post('/location', async (c) => {
  const config = loadConfig();
  if (!config.LOCATION_PING_SECRET) return c.json({ error: 'location ingest disabled' }, 404);
  const raw = await c.req.text();
  if (!verifyLocationSignature(config.LOCATION_PING_SECRET, raw, c.req.header('x-signature'))) {
    return c.json({ error: 'invalid signature' }, 403);
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }
  const parsed = LocationPingSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid ping' }, 400);
  // The signature has no expiry of its own; a stale capturedAt is the replay
  // signal. 409 (not 403) so the Shortcut can tell clock skew from a bad key.
  if (!locationPingFresh(parsed.data)) return c.json({ error: 'stale ping' }, 409);

  const deps = buildDeps();
  const agent = await getAgent(deps.db);
  await recordLocationPing(deps.db, agent.id, parsed.data);
  return c.json({ ok: true });
});

/** Dedicated one-shot callback for browser canaries; no task/workflow state is exposed. */
webhooks.post('/canaries/browser', async (c) => {
  if (!isModuleEnabled(loadConfig(), 'browser')) {
    return c.json({ error: 'browser module disabled' }, 404);
  }
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
  if (!isModuleEnabled(config, 'sms')) return c.text('SMS module disabled', 404);
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
