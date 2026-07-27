import { loadConfig, resetConfigForTest } from '@assistant/config';
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

  it('keeps disabled module entry points inactive', async () => {
    resetConfigForTest();
    loadConfig({ ASSISTANT_MODULES: 'minimal' });
    try {
      const app = createApp();
      const [gmail, sms, browser] = await Promise.all([
        app.request('/webhooks/gmail/pubsub', { method: 'POST' }),
        app.request('/webhooks/twilio/sms', { method: 'POST' }),
        app.request('/webhooks/browser/callback', { method: 'POST' }),
      ]);
      expect(gmail.status).toBe(404);
      expect(sms.status).toBe(404);
      expect(browser.status).toBe(404);
    } finally {
      resetConfigForTest();
      loadConfig(process.env);
    }
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
    const [run, status, health] = await Promise.all([
      app.request('/internal/canaries/run', { method: 'POST' }),
      app.request('/internal/canaries/status'),
      app.request('/internal/canaries/health'),
    ]);
    expect(run.status).toBe(401);
    expect(status.status).toBe(401);
    expect(health.status).toBe(401);
  });

  it('caps oversized bodies on internal routes before parsing (S8)', async () => {
    const app = createApp();
    const res = await app.request('/internal/tasks/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(1024 * 1024 + 1),
    });
    expect(res.status).toBe(413);
  });
});
