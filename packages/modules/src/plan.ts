import { type AssistantModule, type Config, isModuleEnabled, loadConfig } from '@assistant/config';
import type {
  ConfigKey,
  ModuleExternalCost,
  ModuleMeta,
  ModuleSchedulerJob,
  ModuleWorker,
} from './kit.js';
import { assistantModuleMetas } from './meta.js';

export interface DeploymentPlanBillingLine {
  module: AssistantModule;
  service: string;
  tier: 'free-tier-likely' | 'usage';
  note: string;
}

export interface DeploymentPlanExternalCost extends ModuleExternalCost {
  module: AssistantModule;
}

/**
 * Everything deployment needs to know about an installation's composition,
 * derived from module metadata. Provisioning, CI image selection, and the
 * billing explanation all read this one structure, so bash never re-parses
 * `ASSISTANT_MODULES` and cannot drift from the configuration schema.
 */
export interface DeploymentPlan {
  modules: readonly AssistantModule[];
  /** Worker images by plan key, including the ones this installation excludes. */
  workers: Readonly<Record<string, boolean>>;
  workerDetails: readonly (ModuleWorker & { module: AssistantModule })[];
  /** APIs required beyond the always-on platform set. */
  gcpApis: readonly string[];
  pubsubTopics: readonly string[];
  schedulerJobs: readonly (ModuleSchedulerJob & { module: AssistantModule })[];
  serviceAccounts: readonly { id: string; displayName: string; module: AssistantModule }[];
  secretKeys: readonly ConfigKey[];
  billing: {
    gcp: readonly DeploymentPlanBillingLine[];
    external: readonly DeploymentPlanExternalCost[];
  };
}

/**
 * @param metas the modules this build contains; defaults to every module in the
 * repository. Deployment passes the composition file's modules so CI builds
 * images for what is actually compiled in.
 */
export function deploymentPlan(
  config: Config = loadConfig(),
  metas: readonly ModuleMeta[] = assistantModuleMetas,
): DeploymentPlan {
  const modules: AssistantModule[] = [];
  const workers: Record<string, boolean> = {};
  const workerDetails: (ModuleWorker & { module: AssistantModule })[] = [];
  const gcpApis: string[] = [];
  const pubsubTopics: string[] = [];
  const schedulerJobs: (ModuleSchedulerJob & { module: AssistantModule })[] = [];
  const serviceAccounts: { id: string; displayName: string; module: AssistantModule }[] = [];
  const secretKeys: ConfigKey[] = [];
  const gcp: DeploymentPlanBillingLine[] = [];
  const external: DeploymentPlanExternalCost[] = [];

  for (const meta of metas) {
    // Every worker key is present regardless, so a disabled module produces an
    // explicit false rather than a missing key the deploy workflow must guess.
    if (meta.infra?.worker) workers[meta.infra.worker.planKey] = false;
    if (!isModuleEnabled(config, meta.name)) continue;

    modules.push(meta.name);
    const infra = meta.infra;
    if (infra?.worker) {
      workers[infra.worker.planKey] = true;
      workerDetails.push({ ...infra.worker, module: meta.name });
    }
    for (const api of infra?.gcpApis ?? []) gcpApis.push(api);
    for (const topic of infra?.pubsubTopics ?? []) pubsubTopics.push(topic);
    for (const job of infra?.schedulerJobs ?? []) schedulerJobs.push({ ...job, module: meta.name });
    for (const account of infra?.serviceAccounts ?? []) {
      serviceAccounts.push({ ...account, module: meta.name });
    }
    for (const key of infra?.secretKeys ?? []) secretKeys.push(key);
    for (const line of meta.billing.gcp ?? []) gcp.push({ ...line, module: meta.name });
    for (const cost of meta.billing.external ?? []) external.push({ ...cost, module: meta.name });
  }

  return {
    modules,
    workers,
    workerDetails,
    gcpApis,
    pubsubTopics,
    schedulerJobs,
    serviceAccounts,
    secretKeys,
    billing: { gcp, external },
  };
}

/** Human-readable cost explanation for the modules this installation enables. */
export function billingSummary(plan: DeploymentPlan): string {
  const lines: string[] = [];
  if (plan.billing.external.length > 0) {
    lines.push('Third-party services (billed by the vendor, not Google Cloud):');
    for (const cost of plan.billing.external) {
      const requirement = cost.required ? 'required' : 'optional';
      lines.push(`  ${cost.module} — ${cost.vendor} (${requirement}): ${cost.note}`);
      if (cost.url) lines.push(`    ${cost.url}`);
    }
  }
  if (plan.billing.gcp.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('Google Cloud services added by these modules:');
    for (const line of plan.billing.gcp) {
      const tier = line.tier === 'free-tier-likely' ? 'usually free' : 'usage-billed';
      lines.push(`  ${line.module} — ${line.service} (${tier}): ${line.note}`);
    }
  }
  if (lines.length === 0) lines.push('These modules add no infrastructure or vendor cost.');
  return lines.join('\n');
}
