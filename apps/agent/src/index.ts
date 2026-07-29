import { loadConfig } from '@assistant/config';
import { validateAssistantConfig } from '@assistant/modules/meta';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { buildDeps } from './deps.js';
import { initOtel } from './otel-init.js';
import { startPoller } from './poller.js';

const config = loadConfig();

// Fail fast on a misconfigured production deploy rather than breaking the queue
// on the first task or accepting unauthenticated internal calls.
const configProblems = validateAssistantConfig(config);
if (configProblems.length > 0) {
  console.error('FATAL: invalid production configuration:');
  for (const problem of configProblems) console.error(`  - ${problem}`);
  process.exit(1);
}

initOtel();

// Build the dependency graph — and with it install the modules — at boot, not
// lazily on the first request. installModules validates the composition (every
// declared webhook/internal route has a handler; no duplicate paths or task
// kinds), and that check is worthless if it only runs when Cloud Tasks delivers
// the first task in production. A composition mistake now crashes startup, the
// same way validateAssistantConfig above does, instead of surfacing as a
// silent 404 on a live webhook.
const deps = buildDeps();

if (config.QUEUE_DRIVER === 'local') {
  startPoller(deps);
  console.log('local queue poller started (2s interval)');
}
const app = createApp();

// Cloud Run injects PORT; local dev uses AGENT_PORT (8787).
const port = process.env.PORT ? Number(process.env.PORT) : config.AGENT_PORT;
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`agent service listening on :${info.port}`);
});
