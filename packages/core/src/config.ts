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
  return problems;
}

/** Test seam — clears the config cache. */
export function resetConfigForTest(): void {
  cached = undefined;
}
