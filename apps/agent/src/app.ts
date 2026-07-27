import { moduleDiagnostics } from '@assistant/config';
import { Hono } from 'hono';
import { buildDeps } from './deps.js';
import { api } from './routes/api.js';
import { internal } from './routes/internal.js';
import { webhooks } from './routes/webhooks.js';

export function createApp() {
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true, service: 'agent' }));
  app.get('/ready', async (c) => {
    const deps = buildDeps();
    try {
      await deps.db.execute('select 1');
      return c.json({
        ready: true,
        database: 'ready',
        modules: moduleDiagnostics(deps.config),
      });
    } catch {
      return c.json({ ready: false, database: 'unavailable' }, 503);
    }
  });

  app.route('/webhooks', webhooks);
  app.route('/internal', internal);
  app.route('/api', api);

  return app;
}
