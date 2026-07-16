import { Hono } from 'hono';
import { api } from './routes/api.js';
import { internal } from './routes/internal.js';
import { webhooks } from './routes/webhooks.js';

export function createApp() {
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true, service: 'agent' }));

  app.route('/webhooks', webhooks);
  app.route('/internal', internal);
  app.route('/api', api);

  return app;
}
