import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';
import { type AssistantModule, assistantModuleNames, parseAssistantModules } from './modules.js';

export {
  type AssistantModule,
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
  /**
   * Owner-generated bearer token for the native iOS client. Empty leaves the
   * mobile API behind the normal web session only. Keep this separate from
   * AUTH_SECRET: rotating a phone credential must not invalidate web sessions.
   */
  MOBILE_API_TOKEN: z.string().default(''),
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
   * Age-based pruning of conversation/tool/model history. 0 (the default)
   * keeps everything forever — deleting history is an owner policy decision,
   * so the platform ships the machinery and leaves the knob off. A positive
   * value makes the sweep prune rows older than that many days.
   */
  HISTORY_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .max(3650)
    .default(0)
    .refine((days) => days === 0 || days >= 30, {
      message: 'HISTORY_RETENTION_DAYS must be 0 (keep forever) or at least 30',
    }),
  /**
   * Same for the cost ledger. The floor is higher because budget hard caps
   * count a rolling month of cost_events — pruning inside that window would
   * quietly raise the spending limit.
   */
  COST_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .max(3650)
    .default(0)
    .refine((days) => days === 0 || days >= 60, {
      message: 'COST_RETENTION_DAYS must be 0 (keep forever) or at least 60',
    }),
  /**
   * Explicit true/false wins; otherwise Gmail sync runs only in production.
   * The google module is an additional hard gate.
   */
  GMAIL_SYNC_ENABLED: z.enum(['true', 'false']).optional(),
  /**
   * What the assistant's mailbox IS.
   *
   * `direct` (the historical behaviour): people write to the assistant, and the
   * sender of a message is the party directing it. Sender trust therefore
   * decides what the resulting task may do.
   *
   * `forwarded`: the mailbox is a pipe the owner points their own mail into, so
   * the OWNER is the party directing the assistant and the sender is only
   * content. Ingest tasks run at owner trust *and* tainted — the direction and
   * the provenance are tracked separately (see `payload.ingest` in email-sync).
   * Nothing is ever auto-replied in this mode.
   */
  EMAIL_INGEST_MODE: z.enum(['direct', 'forwarded']).default('direct'),
  /**
   * How interesting a forwarded message must be (1-5) before it earns a full
   * triage task. Below it the message is still stored, indexed and remembered —
   * it just does not interrupt the owner or spend reasoning budget.
   */
  EMAIL_INGEST_IMPORTANCE_THRESHOLD: z.coerce.number().int().min(1).max(5).default(3),
  /**
   * Daily ceiling on deep triage tasks from forwarded mail. Owner-trust tasks
   * bypass the external-sender flood backstop (`underExternalTaskLimit`), so
   * ingest needs its own brake or one busy day can exhaust the month's budget.
   */
  EMAIL_INGEST_MAX_TRIAGE_PER_DAY: z.coerce.number().int().min(0).max(1000).default(40),
  /**
   * Recipient domains the assistant may send mail to, comma-separated and
   * empty-means-unrestricted. This mirrors a restriction enforced at the mail
   * provider: without it the assistant queues approval cards for sends the
   * provider will bounce, which trains the owner to approve things that never
   * happen. Enforced as a hard rejection, never as an approval.
   */
  EMAIL_OUTBOUND_DOMAINS: z.string().default(''),
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

/**
 * The recipient domains the assistant may send to, lowercased. An empty list
 * means unrestricted — callers must treat it that way rather than as "deny
 * everything", so an installation that never sets this keeps working.
 */
export function outboundEmailDomains(config: Config = loadConfig()): readonly string[] {
  return config.EMAIL_OUTBOUND_DOMAINS.split(',')
    .map((domain) => domain.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
}

/**
 * May the assistant send mail to this address? Unrestricted when no domains are
 * configured. Subdomains do NOT inherit: `EMAIL_OUTBOUND_DOMAINS=example.com`
 * permits `a@example.com` and not `a@mail.example.com`, because the point is to
 * mirror a provider-side rule exactly rather than to guess at its intent.
 */
export function outboundEmailAllowed(address: string, config: Config = loadConfig()): boolean {
  const domains = outboundEmailDomains(config);
  if (domains.length === 0) return true;
  const domain = address.trim().toLowerCase().split('@').pop() ?? '';
  return domain.length > 0 && domains.includes(domain);
}

/**
 * Drop the process-level cache and re-parse — used by settings actions that
 * persist a new value (for example rotating the mobile token) and need the
 * running process to honour it without a restart.
 */
export function reloadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  cached = undefined;
  return loadConfig(env);
}

/** Test seam — clears the process-level config cache. */
export function resetConfigForTest(): void {
  cached = undefined;
}
