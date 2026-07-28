import type { Config } from '@assistant/config';
import { moduleDiagnostics, validateAssistantConfig } from '@assistant/modules/meta';
import type { CommandRunner } from './runner.js';

export type CheckStatus = 'pass' | 'warn' | 'fail';

/** What a check concluded. Its identity comes from the check that produced it. */
export interface CheckResult {
  status: CheckStatus;
  detail: string;
  /** What the operator must do. Required for anything that did not pass. */
  guidance?: string;
}

export interface CheckOutcome extends CheckResult {
  id: string;
  title: string;
}

export interface PreflightContext {
  config: Config;
  runner: CommandRunner;
  project: string;
}

/**
 * A preflight check: a probe plus the guidance for fixing what it finds.
 *
 * The failures worth checking here — no billing account, an organization policy
 * that forbids public services — are the ones that otherwise surface as an
 * opaque error partway through a deploy, after resources already exist.
 */
export interface PreflightCheck {
  id: string;
  title: string;
  /** Skip with a uniform message when no project could be resolved. */
  needsProject?: boolean;
  run(context: PreflightContext): Promise<CheckResult>;
}

const pass = (detail: string): CheckResult => ({ status: 'pass', detail });
const warn = (detail: string, guidance: string): CheckResult => ({
  status: 'warn',
  detail,
  guidance,
});
const fail = (detail: string, guidance: string): CheckResult => ({
  status: 'fail',
  detail,
  guidance,
});

const gcloudInstalled: PreflightCheck = {
  id: 'gcloud',
  title: 'Google Cloud CLI',
  async run({ runner }) {
    const result = await runner.run('gcloud', ['version', '--format=value(Google Cloud SDK)']);
    return result.ok
      ? pass('installed')
      : fail(
          'not found on PATH',
          'Install the Google Cloud CLI: https://cloud.google.com/sdk/docs/install',
        );
  },
};

const authenticated: PreflightCheck = {
  id: 'auth',
  title: 'Authenticated account',
  async run({ runner }) {
    const result = await runner.run('gcloud', [
      'auth',
      'list',
      '--filter=status:ACTIVE',
      '--format=value(account)',
    ]);
    const account = result.stdout.split('\n')[0]?.trim() ?? '';
    return result.ok && account
      ? pass(account)
      : fail('no active account', 'Run: gcloud auth login');
  },
};

const targetProject: PreflightCheck = {
  id: 'project',
  title: 'Target project',
  async run({ project }) {
    return project
      ? pass(project)
      : fail(
          'no project resolved',
          'Set GCP_PROJECT in .env, or run: gcloud config set project YOUR_PROJECT_ID',
        );
  },
};

/**
 * Billing is the check most worth doing early: without it, API enablement fails
 * partway through provisioning and leaves half a deployment behind.
 */
const billingLinked: PreflightCheck = {
  id: 'billing',
  title: 'Billing account',
  needsProject: true,
  async run({ runner, project }) {
    const result = await runner.run('gcloud', [
      'billing',
      'projects',
      'describe',
      project,
      '--format=value(billingEnabled)',
    ]);
    if (!result.ok) {
      return warn(
        'could not be verified',
        'Checking billing needs the Cloud Billing API and billing.viewer. Confirm manually: https://console.cloud.google.com/billing/linkedaccount',
      );
    }
    return result.stdout.trim().toLowerCase() === 'true'
      ? pass('linked')
      : fail(
          'not linked to this project',
          'Link a billing account before deploying — Cloud Run, Artifact Registry, and Secret Manager all require it: https://console.cloud.google.com/billing/linkedaccount',
        );
  },
};

/**
 * `iam.allowedPolicyMemberDomains` blocks granting `allUsers` the invoker role,
 * which is how both services are published — so a deploy fails at its very last
 * step without this warning.
 */
const publicAccessAllowed: PreflightCheck = {
  id: 'org-policy',
  title: 'Public access policy',
  needsProject: true,
  async run({ runner, project }) {
    const result = await runner.run('gcloud', [
      'resource-manager',
      'org-policies',
      'describe',
      'iam.allowedPolicyMemberDomains',
      `--project=${project}`,
      '--effective',
      '--format=value(listPolicy.allValues)',
    ]);
    // The command exits non-zero when no such policy exists, which is the
    // common and entirely healthy case for a personal project.
    if (!result.ok) return pass('no domain restriction found');
    return result.stdout.trim() === 'ALLOW'
      ? pass('unrestricted')
      : warn(
          'domain-restricted sharing may be enforced',
          'This organization may forbid granting allUsers the Cloud Run invoker role, which publishing the web and agent services requires. Ask an administrator to exempt this project, or expect the final deploy step to fail.',
        );
  },
};

/** The settings `infra/gcp/deploy.sh` refuses to start without. */
const requiredSettings: PreflightCheck = {
  id: 'settings',
  title: 'Required settings',
  async run({ config }) {
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
      ? pass('present')
      : fail(
          `missing ${missing.join(', ')}`,
          'Set these in .env, then re-run. Values are never printed by this tool.',
        );
  },
};

const configurationValid: PreflightCheck = {
  id: 'config',
  title: 'Configuration',
  async run({ config }) {
    const problems = validateAssistantConfig(config);
    return problems.length === 0
      ? pass('valid')
      : fail(`${problems.length} problem(s)`, problems.map((problem) => `- ${problem}`).join('\n'));
  },
};

/**
 * An enabled-but-unconfigured module is not fatal: the platform keeps its tools
 * unregistered and the installation stays recoverable, so this only warns.
 */
const modulesReady: PreflightCheck = {
  id: 'modules',
  title: 'Module readiness',
  async run({ config }) {
    const unready = moduleDiagnostics(config).filter(
      (diagnostic) => diagnostic.enabled && !diagnostic.ready,
    );
    return unready.length === 0
      ? pass('all enabled modules ready')
      : warn(
          unready.map((diagnostic) => `${diagnostic.module} (${diagnostic.detail})`).join(', '),
          'These modules deploy but stay inactive until their settings exist. The manual steps below cover the credentials they need.',
        );
  },
};

export const preflightChecks: readonly PreflightCheck[] = [
  gcloudInstalled,
  authenticated,
  targetProject,
  billingLinked,
  publicAccessAllowed,
  requiredSettings,
  configurationValid,
  modulesReady,
];

/**
 * Run every check, concurrently — they are independent, and several are gcloud
 * round trips the operator would otherwise wait through one at a time. Results
 * keep the declared order so the report reads the same every run.
 */
export async function runPreflight(context: PreflightContext): Promise<CheckOutcome[]> {
  return Promise.all(
    preflightChecks.map(async (check) => {
      const result =
        check.needsProject && !context.project
          ? warn('skipped — no project resolved', 'Resolve the target project first.')
          : await check.run(context);
      return { id: check.id, title: check.title, ...result };
    }),
  );
}

/** Checks that must be resolved before provisioning can safely start. */
export function blocking(outcomes: readonly CheckOutcome[]): CheckOutcome[] {
  return outcomes.filter((outcome) => outcome.status === 'fail');
}
