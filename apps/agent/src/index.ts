import { loadConfig } from '@assistant/core';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { buildDeps } from './deps.js';
import { initOtel } from './otel-init.js';
import { startPoller } from './poller.js';

const config = loadConfig();
initOtel();

if (config.QUEUE_DRIVER === 'local') {
  startPoller(buildDeps());
  console.log('local queue poller started (2s interval)');
}
const app = createApp();

// Cloud Run injects PORT; local dev uses AGENT_PORT (8787).
const port = process.env.PORT ? Number(process.env.PORT) : config.AGENT_PORT;
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`agent service listening on :${info.port}`);
});
