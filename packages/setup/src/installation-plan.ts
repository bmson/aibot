import type { AssistantModule } from '@assistant/config';
import {
  assistantModuleMetas,
  type DeploymentPlan,
  deploymentPlan,
} from '@assistant/modules/installation-meta';
import {
  type CreateInstallationManifestInput,
  createInstallationManifest,
  type InstallationManifest,
  type InstallationResource,
  type InstallationSelection,
} from './installation-manifest.js';

export type InstallationPreviewInput = CreateInstallationManifestInput;

export interface InstallationPreview {
  mode: 'preview-only';
  runtimeGated: true;
  manifest: InstallationManifest;
  deploymentPlan: DeploymentPlan;
  baseGcpApiIntent: readonly string[];
  blockers: readonly string[];
}

const BASE_GCP_APIS = [
  'artifactregistry.googleapis.com',
  'cloudbuild.googleapis.com',
  'cloudtasks.googleapis.com',
  'firestore.googleapis.com',
  'run.googleapis.com',
  'secretmanager.googleapis.com',
  'storage.googleapis.com',
] as const;

export const baseGcpApiIntent = (
  modelProvider: InstallationSelection['modelProvider'],
): readonly string[] => [
  ...BASE_GCP_APIS,
  ...(modelProvider === 'google' ? ['aiplatform.googleapis.com'] : []),
];

function validatePlan(plan: DeploymentPlan, manifest: InstallationManifest): DeploymentPlan {
  const modules = [...plan.modules];
  if (JSON.stringify(modules) !== JSON.stringify(manifest.selection.modules)) {
    throw new Error('Installation preview module selection does not match the deployment plan');
  }
  if (new Set(modules).size !== modules.length)
    throw new Error('Deployment plan contains duplicate modules');
  return {
    modules: [...modules] as AssistantModule[],
    workers: Object.fromEntries(
      Object.entries(plan.workers).sort(([a], [b]) => a.localeCompare(b)),
    ),
    gcpApis: [...plan.gcpApis].sort(),
    schedulerJobs: [...plan.schedulerJobs].sort((a, b) => a.name.localeCompare(b.name)),
    billing: {
      gcp: [...plan.billing.gcp].sort((a, b) =>
        `${a.module}:${a.service}`.localeCompare(`${b.module}:${b.service}`),
      ),
      external: [...plan.billing.external].sort((a, b) =>
        `${a.module}:${a.vendor}`.localeCompare(`${b.module}:${b.vendor}`),
      ),
    },
  };
}

/**
 * Build a deterministic, offline installation preview. No gcloud, network,
 * authorization, or provisioning call is made here. The deployment plan only
 * consumes the validated module selection and metadata; it does not load
 * credentials or inspect a customer project.
 */
export function previewInstallation(input: InstallationPreviewInput): InstallationPreview {
  const manifest = createInstallationManifest(input);
  const plan = deploymentPlan(
    { ASSISTANT_MODULES: [...manifest.selection.modules] },
    assistantModuleMetas,
  );
  const normalizedPlan = validatePlan(plan, manifest);
  return {
    mode: 'preview-only',
    runtimeGated: true,
    manifest,
    deploymentPlan: normalizedPlan,
    baseGcpApiIntent: baseGcpApiIntent(manifest.selection.modelProvider),
    blockers: [
      'Preview only: no cloud checks, authorization, provisioning, or runtime readiness claim was performed.',
      'Remaining runtime adapters: Firestore application and dispatcher composition are not activated by this preview.',
      'Google model and passkey/recovery runtime remain separate implementation gates.',
      'Terraform/bootstrap implementation is incomplete; live provisioning, IAM, model availability, and Firestore index validation require cloud access.',
      'Resource ownership and provider labels are declarations in this manifest, not cloud-verified facts.',
    ],
  };
}

export type { InstallationResource, InstallationSelection };
