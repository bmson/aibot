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
  /** Trace-archive bucket (30-day lifecycle); empty = store traces in the workspace. */
  TRACES_BUCKET: z.string().default(''),
  /** Explicit opt-in: canaries send one real email/SMS and launch one browser job. */
  CANARY_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /** Structural ceiling across one full canary run (SMS + browser + bounded chat). */
  CANARY_MAX_COST_USD: z.coerce.number().min(0.01).max(0.1).default(0.03),
});

export type Config = z.infer<typeof ConfigSchema>;

let cached: Config | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  cached ??= ConfigSchema.parse(env);
  return cached;
}

/** Test seam — clears the config cache. */
export function resetConfigForTest(): void {
  cached = undefined;
}
