import { type AssistantModule, type Config, isModuleEnabled } from '@assistant/config';

export interface ManualStep {
  id: string;
  title: string;
  /** Why this cannot be done for you. Honesty here is the point of the step. */
  reason: string;
  instructions: readonly string[];
  /** Settings whose presence means the step is done. */
  satisfiedBy?: readonly (keyof Config)[];
  /** The module this belongs to; absent means it always applies. */
  module?: AssistantModule;
}

/**
 * The steps no tool can complete for you.
 *
 * Everything automatable has already been automated by the provisioner — API
 * enablement included. What remains is genuinely manual: Google exposes no API
 * for creating an OAuth consent screen or a web OAuth client, Workspace
 * allowlisting is an administrator action, and DNS lives at your registrar.
 * Listing them explicitly is better than a setup that claims to be zero-config
 * and then stalls.
 */
const manualSteps: readonly ManualStep[] = [
  {
    id: 'oauth-consent',
    title: 'Create the OAuth consent screen and client',
    reason: 'Google publishes no API for creating a consent screen or a web OAuth client.',
    module: 'google',
    instructions: [
      'Open APIs & Services → OAuth consent screen and configure the audience, application name, and support email.',
      'If the app is external and still in testing, add ASSISTANT_EMAIL as a test user.',
      'Create a Web application OAuth client with redirect URI http://localhost:8123/callback.',
      'Put the client ID and secret in .env as GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.',
    ],
    satisfiedBy: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'],
  },
  {
    id: 'bot-token',
    title: 'Authorize the assistant account',
    reason: 'The assistant authorizes itself through a browser once; no headless path exists.',
    module: 'google',
    instructions: [
      'Run: pnpm auth:bot',
      'Complete the browser flow signed in as ASSISTANT_EMAIL.',
      'If a Workspace administrator blocks the client, they must allowlist it in Admin Console → Security → API controls.',
      'Re-run the deploy so the refresh token reaches Secret Manager.',
    ],
    satisfiedBy: ['BOT_GOOGLE_REFRESH_TOKEN'],
  },
  {
    id: 'web-oauth',
    title: 'Add the dashboard redirect URI',
    reason: 'The redirect URI is only known once Cloud Run has assigned the web service its URL.',
    instructions: [
      'In the Google console, add <AUTH_URL>/api/auth/callback/google to the OAuth client used for dashboard sign-in.',
      'The deploy prints the exact URL when it finishes.',
    ],
    satisfiedBy: ['AUTH_GOOGLE_ID', 'AUTH_GOOGLE_SECRET'],
  },
  {
    id: 'dns',
    title: 'Point your domain at Cloud Run',
    reason: 'DNS records live at your registrar, outside the project.',
    instructions: [
      'Create the records shown by: gcloud beta run domain-mappings describe --domain=<WEB_DOMAIN>',
      'Propagation can take hours; this step is safe to resume later.',
    ],
  },
  {
    id: 'twilio-webhook',
    title: "Point the Twilio number at the agent's webhook",
    reason:
      'Automatable through the Twilio API, but the wizard does not hold Twilio credentials with write scope.',
    module: 'sms',
    instructions: [
      "Set the number's inbound SMS webhook to <AGENT_URL>/webhooks/twilio/sms.",
      'The deploy prints the agent URL when it finishes.',
    ],
  },
  {
    id: 'gmail-watch',
    title: 'Start the Gmail watch',
    reason: 'The first watch registration is a one-off kick after Pub/Sub exists.',
    module: 'google',
    instructions: [
      'Run: gcloud scheduler jobs run assistant-gmail-watch --location=<GCP_LOCATION>',
    ],
  },
];

export interface ManualStepStatus extends ManualStep {
  /** True when the settings this step produces are already present. */
  done: boolean;
}

/** The manual steps that apply to this installation, with what is already done. */
export function manualStepsFor(config: Config): ManualStepStatus[] {
  return manualSteps
    .filter((step) => !step.module || isModuleEnabled(config, step.module))
    .map((step) => ({
      ...step,
      done:
        (step.satisfiedBy ?? []).length > 0
          ? (step.satisfiedBy ?? []).every((key) => Boolean(config[key]))
          : false,
    }));
}
