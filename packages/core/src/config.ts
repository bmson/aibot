import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

// Load repo-root .env once, wherever the process was started from.
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const envFile = path.join(repoRoot, '.env');
if (existsSync(envFile)) {
  dotenv.config({ path: envFile });
}

const ConfigSchema = z.object({
  DATABASE_URL: z.string().default('postgres://assistant:assistant@localhost:5432/assistant'),
  OPENROUTER_API_KEY: z.string().default(''),
  OWNER_EMAIL: z.string().default('bmson@bmson.com'),
  OWNER_PHONE: z.string().default(''),
  QUEUE_DRIVER: z.enum(['local', 'cloudtasks']).default('local'),
  FILES_DRIVER: z.enum(['local', 'gcs']).default('local'),
  GCS_ENDPOINT: z.string().default('http://localhost:4443'),
  WORKSPACE_BUCKET: z.string().default('assistant-workspace'),
  PUBLIC_URL: z.string().default('http://localhost:8787'),
  WEB_PORT: z.coerce.number().default(3000),
  AGENT_PORT: z.coerce.number().default(8787),
  /**
   * Internal callbacks use Google-signed OIDC in deployed environments. The
   * shared-secret mode is an explicit local-development escape hatch only.
   */
  INTERNAL_AUTH_MODE: z.enum(['oidc', 'shared-secret']).default('oidc'),
  INTERNAL_API_SECRET: z.string().default(''),
  /** Service URL used to derive a distinct OIDC audience for each internal route. */
  INTERNAL_OIDC_AUDIENCE: z.string().default(''),
  INTERNAL_OIDC_SERVICE_ACCOUNT: z.string().default(''),
  /** Expected `email` claim on the Pub/Sub push ID token. */
  GMAIL_PUSH_SERVICE_ACCOUNT: z.string().default(''),
  /** Explicit opt-in for bypassing owner authentication outside production. */
  AUTH_DEV_BYPASS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  OTEL_SERVICE_NAME: z.string().default('assistant'),
  OTEL_EXPORTER: z.enum(['console', 'otlp', 'none']).default('none'),
  // Phase 3+
  GOOGLE_OAUTH_CLIENT_ID: z.string().default(''),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().default(''),
  BOT_GOOGLE_REFRESH_TOKEN: z.string().default(''),
  /** projects/<id>/topics/<name> — enables Gmail push; local dev polls instead. */
  GMAIL_PUBSUB_TOPIC: z.string().default(''),
  // Cloud deploy (QUEUE_DRIVER=cloudtasks)
  GCP_PROJECT: z.string().default(''),
  GCP_LOCATION: z.string().default('us-west1'),
  CLOUD_TASKS_QUEUE: z.string().default('agent-steps'),
  /** The agent service's own public URL (Cloud Tasks callback target). */
  AGENT_URL: z.string().default(''),
  // Phase 4+
  TWILIO_ACCOUNT_SID: z.string().default(''),
  TWILIO_AUTH_TOKEN: z.string().default(''),
  TWILIO_FROM_NUMBER: z.string().default(''),
  // Phase 6+
  PROFILE_ENC_KEY: z.string().default(''),
  /** local = detached child process; cloudrun = Cloud Run Job execution. */
  BROWSER_DRIVER: z.enum(['local', 'cloudrun']).default('local'),
  BROWSER_JOB_NAME: z.string().default('assistant-browser'),
  /** Code-execution worker (Phase 13): local child process vs Cloud Run Job. */
  CODE_DRIVER: z.enum(['local', 'cloudrun']).default('local'),
  CODE_JOB_NAME: z.string().default('assistant-code'),
  /** Document-processor worker (Phase 14): local child process vs Cloud Run Job. */
  PROCESSOR_DRIVER: z.enum(['local', 'cloudrun']).default('local'),
  PROCESSOR_JOB_NAME: z.string().default('assistant-processor'),
  /** Location context (Phase 15): HMAC key the owner's Shortcut signs pings with; empty disables ingest. */
  LOCATION_PING_SECRET: z.string().default(''),
  /** How many days a location ping is kept before the sweep purges it. */
  LOCATION_RETENTION_DAYS: z.coerce.number().min(1).max(90).default(3),
  /**
   * Gmail sync (poll + push) on/off. Explicit 'true'/'false' wins; unset it is
   * ON only in production. Stops a local dev agent that shares the prod bot
   * refresh token from double-triaging the live mailbox.
   */
  GMAIL_SYNC_ENABLED: z.enum(['true', 'false']).optional(),
  /**
   * Web search: which provider backs the web.search tool; 'none' disables it.
   * No Google option on purpose — Google discontinued whole-web Custom Search
   * (Mar 2026) and its replacements are grounding-shaped (answer+citations), not
   * link-list APIs. brave/tavily/serper are the clean link-returning options.
   */
  SEARCH_PROVIDER: z.enum(['none', 'brave', 'tavily', 'serper']).default('none'),
  /** API key for SEARCH_PROVIDER; web.search is unregistered without it. */
  SEARCH_API_KEY: z.string().default(''),
  /** Self-maintenance (Phase 21): a GitHub token the bot opens self-PRs with; empty disables PRs. */
  GITHUB_TOKEN: z.string().default(''),
  GITHUB_REPO: z.string().default('bmson/aibot'),
  /** Trace-archive bucket (30-day lifecycle); empty = store traces in the workspace. */
  TRACES_BUCKET: z.string().default(''),
  /** Explicit opt-in: canaries send one real email/SMS and launch one browser job. */
  CANARY_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /** Structural ceiling across one full canary run (SMS + browser + bounded chat). */
  CANARY_MAX_COST_USD: z.coerce.number().min(0.01).max(0.1).default(0.03),
  /**
   * Long-running chat auto-recall (Phase 1). When on, each owner chat turn
   * embeds the incoming message and injects a bounded block of semantically
   * relevant earlier discussion from the owner's own past chats — the "one
   * forever thread" experience. Off by default: opt in and measure.
   */
  CHAT_RECALL_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export type Config = z.infer<typeof ConfigSchema>;

let cached: Config | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  cached ??= ConfigSchema.parse(env);
  return cached;
}

/**
 * Fail loudly at startup when a production-shaped config is missing a key that
 * would otherwise fail silently much later (an empty AGENT_URL makes
 * `new URL('/internal/tasks/execute', AGENT_URL)` throw only when the first task
 * dispatches; empty OIDC settings make every internal call unauthenticated).
 * Returns the list of problems so the caller can log and exit; empty = healthy.
 */
export function validateProdConfig(config: Config = loadConfig()): string[] {
  // Only a cloud deploy (the queue driver Cloud Tasks uses) is production-shaped.
  // Local dev keeps the schema's oidc default but runs shared-secret with no GCP
  // wiring, so it must not trip these checks.
  if (config.QUEUE_DRIVER !== 'cloudtasks') return [];
  const problems: string[] = [];
  if (!config.AGENT_URL) problems.push('AGENT_URL is required when QUEUE_DRIVER=cloudtasks');
  if (!config.GCP_PROJECT) problems.push('GCP_PROJECT is required when QUEUE_DRIVER=cloudtasks');
  if (!config.CLOUD_TASKS_QUEUE) problems.push('CLOUD_TASKS_QUEUE is required');
  if (config.INTERNAL_AUTH_MODE === 'oidc') {
    if (!config.INTERNAL_OIDC_AUDIENCE) {
      problems.push('INTERNAL_OIDC_AUDIENCE is required when INTERNAL_AUTH_MODE=oidc');
    }
    if (!config.INTERNAL_OIDC_SERVICE_ACCOUNT) {
      problems.push('INTERNAL_OIDC_SERVICE_ACCOUNT is required when INTERNAL_AUTH_MODE=oidc');
    }
  }
  // More keys that otherwise fail only at first use in prod. These are all
  // boot-fatal on purpose — validateProdConfig's caller exits — so only include
  // checks that can actually trip (empty-default or a bad-in-prod value) AND
  // whose absence genuinely breaks the service. Google OAuth is deliberately NOT
  // here: the agent runs degraded without it (Google tools just don't register).
  if (!config.OPENROUTER_API_KEY) {
    problems.push('OPENROUTER_API_KEY is required (every model call fails without it)');
  }
  if (config.PUBLIC_URL.includes('localhost')) {
    problems.push('PUBLIC_URL still points at localhost — set the public service URL for webhooks');
  }
  if (config.FILES_DRIVER === 'gcs' && !config.WORKSPACE_BUCKET) {
    problems.push('WORKSPACE_BUCKET is required when FILES_DRIVER=gcs');
  }
  if (config.GMAIL_PUBSUB_TOPIC && !config.GMAIL_PUSH_SERVICE_ACCOUNT) {
    // A push topic without the SA to authenticate its notifications means every
    // Gmail push 403s (the outage that blacked out email for two days).
    problems.push('GMAIL_PUSH_SERVICE_ACCOUNT is required when GMAIL_PUBSUB_TOPIC is set');
  }
  // No PROFILE_ENC_KEY check here, deliberately. Under BROWSER_DRIVER=cloudrun
  // the agent never reads that key: CloudRunJobLauncher overrides only
  // BROWSER_JOB_INPUT, and the browser Cloud Run Job gets the key from its own
  // Secret Manager binding — which is the least-privilege split deploy.sh
  // documents ("the browser can read only its profile key"). Requiring it here
  // demanded a secret the agent has no way to use and no grant to read, and it
  // was boot-fatal: the agent crash-looped on startup and Cloud Run held every
  // release on the previous revision. Only BROWSER_DRIVER=local passes the key
  // through (LocalLauncher), and that path is not production.
  return problems;
}

/**
 * Whether this process should sync the bot's Gmail. Explicit GMAIL_SYNC_ENABLED
 * wins; unset, it is on only in production — so a local dev agent booted with
 * the prod bot refresh token does not double-triage the live mailbox.
 */
export function gmailSyncEnabled(config: Config = loadConfig()): boolean {
  if (config.GMAIL_SYNC_ENABLED === 'true') return true;
  if (config.GMAIL_SYNC_ENABLED === 'false') return false;
  return process.env.NODE_ENV === 'production';
}

/** Test seam — clears the config cache. */
export function resetConfigForTest(): void {
  cached = undefined;
}
