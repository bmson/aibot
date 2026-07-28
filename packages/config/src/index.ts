import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';
import { type AssistantModule, assistantModuleNames, parseAssistantModules } from './modules.js';

export {
  type AssistantModule,
  allAssistantModules,
  assistantModuleNames,
  isModuleEnabled,
  parseAssistantModules,
} from './modules.js';

// Load the repository's one environment file regardless of the process cwd.
export const repoRoot = process.env.ASSISTANT_REPO_ROOT
  ? path.resolve(process.env.ASSISTANT_REPO_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const envFile = path.join(repoRoot, '.env');
if (existsSync(envFile)) {
  dotenv.config({ path: envFile });
}

const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

/**
 * The single authoritative configuration schema for every app, package, worker,
 * and deployment script. Values stay flat because they map one-to-one to
 * environment variables and Secret Manager bindings.
 */
const ConfigSchema = z.object({
  // Safe generic identity defaults. Real installations write explicit values.
  ASSISTANT_NAME: z.string().trim().min(1).default('Assistant'),
  ASSISTANT_EMAIL: z.string().trim().email().default('assistant@example.com'),
  ASSISTANT_WORKSPACE_ID: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
    .default('assistant'),
  ASSISTANT_TIMEZONE: z.string().trim().min(1).default('UTC'),
  ASSISTANT_LOCALE: z.string().trim().min(2).default('en'),
  ASSISTANT_SIGNATURE: z.string().default('— Assistant'),
  ASSISTANT_MODULES: z
    .string()
    .default('all')
    .transform((value, ctx): AssistantModule[] => {
      try {
        return parseAssistantModules(value);
      } catch (error) {
        ctx.addIssue({
          code: 'custom',
          message:
            error instanceof Error
              ? error.message
              : `expected a comma-separated subset of: ${assistantModuleNames.join(', ')}`,
        });
        return z.NEVER;
      }
    }),

  DATABASE_URL: z.string().default('postgres://assistant:assistant@localhost:5432/assistant'),
  OPENROUTER_API_KEY: z.string().default(''),
  OWNER_NAME: z.string().trim().min(1).default('Owner'),
  OWNER_EMAIL: z.string().trim().email().default('owner@example.com'),
  OWNER_PHONE: z.string().default(''),
  /** Optional separate production URL used by local deployment scripts. */
  PROD_DATABASE_URL: z.string().default(''),
  AUTH_SECRET: z.string().default(''),
  AUTH_GOOGLE_ID: z.string().default(''),
  AUTH_GOOGLE_SECRET: z.string().default(''),
  AUTH_URL: z.string().default(''),
  AUTH_TRUST_HOST: z.enum(['true', 'false']).optional(),
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
  AUTH_DEV_BYPASS: booleanString,
  /**
   * Explicit bypass for a production-built container published only on the
   * local machine. Auth resolution additionally requires a loopback AUTH_URL
   * and QUEUE_DRIVER=local.
   */
  AUTH_LOCALHOST_BYPASS: booleanString,
  OTEL_SERVICE_NAME: z.string().default('assistant'),
  OTEL_EXPORTER: z.enum(['console', 'otlp', 'none']).default('none'),
  GOOGLE_OAUTH_CLIENT_ID: z.string().default(''),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().default(''),
  BOT_GOOGLE_REFRESH_TOKEN: z.string().default(''),
  /** projects/<id>/topics/<name> — enables Gmail push; local dev polls instead. */
  GMAIL_PUBSUB_TOPIC: z.string().default(''),
  GCP_PROJECT: z.string().default(''),
  GCP_LOCATION: z.string().default('us-west1'),
  CLOUD_TASKS_QUEUE: z.string().default('agent-steps'),
  /** The agent service's own public URL (Cloud Tasks callback target). */
  AGENT_URL: z.string().default(''),
  TWILIO_ACCOUNT_SID: z.string().default(''),
  TWILIO_AUTH_TOKEN: z.string().default(''),
  TWILIO_FROM_NUMBER: z.string().default(''),
  PROFILE_ENC_KEY: z.string().default(''),
  /** local = detached child process; cloudrun = Cloud Run Job execution. */
  BROWSER_DRIVER: z.enum(['local', 'cloudrun']).default('local'),
  BROWSER_JOB_NAME: z.string().default('assistant-browser'),
  /** Code-execution worker: local child process vs Cloud Run Job. */
  CODE_DRIVER: z.enum(['local', 'cloudrun']).default('local'),
  CODE_JOB_NAME: z.string().default('assistant-code'),
  /** Document-processor worker: local child process vs Cloud Run Job. */
  PROCESSOR_DRIVER: z.enum(['local', 'cloudrun']).default('local'),
  PROCESSOR_JOB_NAME: z.string().default('assistant-processor'),
  /** HMAC key used by the owner's location Shortcut; empty disables ingest. */
  LOCATION_PING_SECRET: z.string().default(''),
  LOCATION_RETENTION_DAYS: z.coerce.number().min(1).max(90).default(3),
  /**
   * Explicit true/false wins; otherwise Gmail sync runs only in production.
   * The google module is an additional hard gate.
   */
  GMAIL_SYNC_ENABLED: z.enum(['true', 'false']).optional(),
  SEARCH_PROVIDER: z.enum(['none', 'brave', 'tavily', 'serper']).default('none'),
  SEARCH_API_KEY: z.string().default(''),
  GITHUB_TOKEN: z.string().default(''),
  GITHUB_REPO: z.string().default(''),
  TRACES_BUCKET: z.string().default(''),
  /** Explicit opt-in: canaries perform real provider side effects. */
  CANARY_ENABLED: booleanString,
  CANARY_MAX_COST_USD: z.coerce.number().min(0.01).max(0.1).default(0.03),
  CHAT_RECALL_ENABLED: booleanString,
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Every setting name in the schema, including optional ones that are absent
 * from a parsed configuration. Modules declare the keys they own, and a
 * conformance test checks those declarations against this list.
 */
export const configKeyNames = Object.keys(ConfigSchema.shape) as readonly (keyof Config)[];

let cached: Config | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  cached ??= ConfigSchema.parse(env);
  return cached;
}

/**
 * Fail loudly when a cloud-shaped installation would otherwise boot broken.
 * Local and intentionally minimal installations may run in a degraded state.
 *
 * This covers the platform's own settings only. Module-specific problems are
 * declared by each module and collected by `validateAssistantConfig` in
 * `@assistant/modules`, which is what apps and setup tooling should call.
 */
export function validateProdConfig(config: Config = loadConfig()): string[] {
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
  if (!config.OPENROUTER_API_KEY) {
    problems.push('OPENROUTER_API_KEY is required (every model call fails without it)');
  }
  if (config.PUBLIC_URL.includes('localhost')) {
    problems.push('PUBLIC_URL still points at localhost — set the public service URL for webhooks');
  }
  if (config.FILES_DRIVER === 'gcs' && !config.WORKSPACE_BUCKET) {
    problems.push('WORKSPACE_BUCKET is required when FILES_DRIVER=gcs');
  }
  return problems;
}

/** Test seam — clears the process-level config cache. */
export function resetConfigForTest(): void {
  cached = undefined;
}
