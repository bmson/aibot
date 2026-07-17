import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';

describe('agent app', () => {
  it('responds to /health', async () => {
    const app = createApp();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: 'agent' });
  });

  it('stubs the Twilio webhook as 501 until Phase 4', async () => {
    const app = createApp();
    const twilio = await app.request('/webhooks/twilio/sms', { method: 'POST' });
    expect(twilio.status).toBe(501);
  });

  it('rejects Pub/Sub pushes without a valid Google OIDC token', async () => {
    const app = createApp();
    const noToken = await app.request('/webhooks/gmail/pubsub', { method: 'POST' });
    expect(noToken.status).toBe(401);
    const badToken = await app.request('/webhooks/gmail/pubsub', {
      method: 'POST',
      headers: { authorization: 'Bearer not-a-jwt' },
    });
    expect(badToken.status).toBe(403);
  });

  it('rejects malformed browser canary callbacks before touching persistence', async () => {
    const app = createApp();
    const response = await app.request('/webhooks/canaries/browser', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: 'not-a-run', token: '', result: {} }),
    });
    expect(response.status).toBe(400);
  });

  it('keeps canary execution and status behind internal authentication', async () => {
    const app = createApp();
    const [run, status] = await Promise.all([
      app.request('/internal/canaries/run', { method: 'POST' }),
      app.request('/internal/canaries/status'),
    ]);
    expect(run.status).toBe(401);
    expect(status.status).toBe(401);
  });
});
