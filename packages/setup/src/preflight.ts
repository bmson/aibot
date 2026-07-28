import type { Config } from '@assistant/config';
import { moduleDiagnostics, validateAssistantConfig } from '@assistant/modules/meta';
import type { CommandRunner } from './runner.js';

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface CheckOutcome {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  /** What the operator must do when this check does not pass. */
  guidance?: string;
}

export interface PreflightContext {
  config: Config;
  runner: CommandRunner;
  project: string;
}

/**
 * Checks that run before anything is provisioned. Each one is a probe plus the
 * guidance for fixing it, because the failures that matter here — no billing
 * account, an org policy that forbids public services — are the ones that
 * otherwise surface as an opaque error halfway through a deploy.
 */
export type PreflightCheck = (context: PreflightContext) => Promise<CheckOutcome>;

const checkGcloud: PreflightCheck = async ({ runner }) => {
  const result = await runner.run('gcloud', ['version', '--format=value(Google Cloud SDK)']);
  return result.ok
    ? { id: 'gcloud', title: 'Google Cloud CLI', status: 'pass', detail: 'installed' }
    : {
        id: 'gcloud',
        title: 'Google Cloud CLI',
        status: 'fail',
        detail: 'not found on PATH',
        guidance: 'Install the Google Cloud CLI: https://cloud.google.com/sdk/docs/install',
      };
};

const checkAuth: PreflightCheck = async ({ runner }) => {
  const result = await runner.run('gcloud', [
    'auth',
    'list',
    '--filter=status:ACTIVE',
    '--format=value(account)',
  ]);
  const account = result.stdout.split('\n')[0]?.trim() ?? '';
  return result.ok && account
    ? { id: 'auth', title: 'Authenticated account', status: 'pass', detail: account }
    : {
        id: 'auth',
        title: 'Authenticated account',
        status: 'fail',
        detail: 'no active account',
        guidance: 'Run: gcloud auth login',
      };
};

const checkProject: PreflightCheck = async ({ project }) =>
  project
    ? { id: 'project', title: 'Target project', status: 'pass', detail: project }
    : {
        id: 'project',
        title: 'Target project',
        status: 'fail',
        detail: 'no project resolved',
        guidance: 'Set GCP_PROJECT in .env, or run: gcloud config set project YOUR_PROJECT_ID',
      };

/**
 * Billing is the check most worth doing early: without it, API enablement
 * fails partway through provisioning and leaves half a deployment behind.
 */
const checkBilling: PreflightCheck = async ({ runner, project }) => {
  if (!project) {
    return {
      id: 'billing',
      title: 'Billing account',
      status: 'fail',
      detail: 'skipped — no project',
    };
  }
  const result = await runner.run('gcloud', [
    'billing',
    'projects',
    'describe',
    project,
    '--format=value(billingEnabled)',
  ]);
  if (!result.ok) {
    return {
      id: 'billing',
      title: 'Billing account',
      status: 'warn',
      detail: 'could not be verified',
      guidance:
        'Checking billing needs the Cloud Billing API and billing.viewer. Confirm manually: https://console.cloud.google.com/billing/linkedaccount',
    };
  }
  return result.stdout.trim().toLowerCase() === 'true'
    ? { id: 'billing', title: 'Billing account', status: 'pass', detail: 'linked' }
    : {
        id: 'billing',
        title: 'Billing account',
        status: 'fail',
        detail: 'not linked to this project',
        guidance:
          'Link a billing account before deploying — Cloud Run, Artifact Registry, and Secret Manager all require it: https://console.cloud.google.com/billing/linkedaccount',
      };
};

/**
 * `iam.allowedPolicyMemberDomains` blocks granting `allUsers` the invoker role,
 * which is how both services are published. Deploy fails at the very last step
 * without this warning.
 */
const checkPublicAccessPolicy: PreflightCheck = async ({ runner, project }) => {
  if (!project) {
    return {
      id: 'org-policy',
      title: 'Public access policy',
      status: 'warn',
      detail: 'skipped — no project',
    };
  }
  const result = await runner.run('gcloud', [
    'resource-manager',
    'org-policies',
    'describe',
    'iam.allowedPolicyMemberDomains',
    `--project=${project}`,
    '--effective',
    '--format=value(listPolicy.allValues)',
  ]);
  if (!result.ok) {
    return {
      id: 'org-policy',
      title: 'Public access policy',
      status: 'pass',
      detail: 'no domain restriction found',
    };
  }
  return result.stdout.trim() === 'ALLOW'
    ? { id: 'org-policy', title: 'Public access policy', status: 'pass', detail: 'unrestricted' }
    : {
        id: 'org-policy',
        title: 'Public access policy',
        status: 'warn',
        detail: 'domain-restricted sharing may be enforced',
        guidance:
          'This organization may forbid granting allUsers the Cloud Run invoker role, which publishing the web and agent services requires. Ask an administrator to exempt this project, or expect the final deploy step to fail.',
      };
};

/** The settings `infra/gcp/deploy.sh` refuses to start without. */
const checkRequiredSettings: PreflightCheck = async ({ config }) => {
  const missing = (
    [
      ['PROD_DATABASE_URL', config.PROD_DATABASE_URL],
      ['OPENROUTER_API_KEY', config.OPENROUTER_API_KEY],
      ['ASSISTANT_EMAIL', config.ASSISTANT_EMAIL],
      ['OWNER_EMAIL', config.OWNER_EMAIL],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([name]) => name);
  return missing.length === 0
    ? { id: 'settings', title: 'Required settings', status: 'pass', detail: 'present' }
    : {
        id: 'settings',
        title: 'Required settings',
        status: 'fail',
        detail: `missing ${missing.join(', ')}`,
        guidance: 'Set these in .env, then re-run. Values are never printed by this tool.',
      };
};

const checkConfiguration: PreflightCheck = async ({ config }) => {
  const problems = validateAssistantConfig(config);
  return problems.length === 0
    ? { id: 'config', title: 'Configuration', status: 'pass', detail: 'valid' }
    : {
        id: 'config',
        title: 'Configuration',
        status: 'fail',
        detail: `${problems.length} problem(s)`,
        guidance: problems.map((problem) => `- ${problem}`).join('\n'),
      };
};

/**
 * An enabled-but-unconfigured module is not fatal: the platform keeps its tools
 * unregistered and the installation stays recoverable, so this warns.
 */
const checkModuleReadiness: PreflightCheck = async ({ config }) => {
  const unready = moduleDiagnostics(config).filter(
    (diagnostic) => diagnostic.enabled && !diagnostic.ready,
  );
  return unready.length === 0
    ? {
        id: 'modules',
        title: 'Module readiness',
        status: 'pass',
        detail: 'all enabled modules ready',
      }
    : {
        id: 'modules',
        title: 'Module readiness',
        status: 'warn',
        detail: unready
          .map((diagnostic) => `${diagnostic.module} (${diagnostic.detail})`)
          .join(', '),
        guidance:
          'These modules deploy but stay inactive until their settings exist. The manual steps below cover the credentials they need.',
      };
};

export const preflightChecks: readonly PreflightCheck[] = [
  checkGcloud,
  checkAuth,
  checkProject,
  checkBilling,
  checkPublicAccessPolicy,
  checkRequiredSettings,
  checkConfiguration,
  checkModuleReadiness,
];

export async function runPreflight(context: PreflightContext): Promise<CheckOutcome[]> {
  const outcomes: CheckOutcome[] = [];
  for (const check of preflightChecks) outcomes.push(await check(context));
  return outcomes;
}

export function blocking(outcomes: readonly CheckOutcome[]): CheckOutcome[] {
  return outcomes.filter((outcome) => outcome.status === 'fail');
}
