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
import type { ModuleWebhookRequest } from '@assistant/modules';
import { validateTwilioSignature } from '@assistant/tools';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { recordCanaryBrowserResult } from '../canaries.js';
import { agentServices, buildDeps, composedModuleMetas } from '../deps.js';
import { syncMailbox } from '../email-sync.js';
import { verifyGoogleServiceAccountToken } from '../google-oidc.js';

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

/**
 * Module-declared webhooks. Mounting is static (Hono routes register at import
 * time), so declarations come from the composed metas; the enabled-guard and
 * auth run per request, and the handler is looked up from the installed set —
 * a module the configuration disables answers 404 without its code running.
 * Auth precedes the handler always: the closed union in the meta is what a
 * module CAN declare, and the mounter is the only place that applies it.
 */
for (const meta of composedModuleMetas) {
  for (const route of meta.webhooks ?? []) {
    webhooks.post(route.path, async (c) => {
      const config = loadConfig();
      if (!isModuleEnabled(config, meta.name)) {
        return c.json({ error: `${meta.name} module disabled` }, 404);
      }

      let form: Record<string, string> | undefined;
      if (route.auth.kind === 'googleOidc') {
        const authorization = c.req.header('authorization');
        if (!authorization) return c.json({ error: 'missing token' }, 401);
        const verified = await verifyGoogleServiceAccountToken(authorization, {
          audience: `${config.PUBLIC_URL}/webhooks${route.path}`,
          serviceAccount: String(config[route.auth.serviceAccountKey] ?? ''),
        });
        if (!verified) return c.json({ error: 'invalid token' }, 403);
      } else if (route.auth.kind === 'twilioSignature') {
        if (!config.TWILIO_AUTH_TOKEN) return c.text('Twilio not configured', 501);
        const parsed = await c.req.parseBody();
        form = {};
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === 'string') form[key] = value;
        }
        const valid = validateTwilioSignature({
          authToken: config.TWILIO_AUTH_TOKEN,
          url: `${config.PUBLIC_URL}/webhooks${route.path}`,
          params: form,
          signature: c.req.header('x-twilio-signature') ?? '',
        });
        if (!valid) return c.text('invalid signature', 403);
      }
      // 'oneShotToken' routes authenticate inside the handler: the per-launch
      // token in the body is the credential, exactly as the hardcoded routes did.

      const deps = buildDeps();
      const handler = deps.modules.webhookHandler(route.path);
      if (!handler) return c.json({ error: `${meta.name} module disabled` }, 404);
      const request: ModuleWebhookRequest = {
        json: async <T>() => (await c.req.json().catch(() => null)) as T | null,
        form: async () => form ?? {},
        header: (name) => c.req.header(name),
      };
      const response = await handler(agentServices(deps), request);
      if ('json' in response) {
        return c.json(response.json as object, response.status as ContentfulStatusCode);
      }
      return c.text(
        response.text,
        response.status as ContentfulStatusCode,
        response.contentType ? { 'content-type': response.contentType } : undefined,
      );
    });
  }
}
