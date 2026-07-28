import { type AssistantModule, type Config, isModuleEnabled } from '@assistant/config';
import type {
  ModuleBillingLine,
  ModuleExternalCost,
  ModuleMeta,
  ModuleSchedulerJob,
} from './contract.js';

/** A declaration tagged with the module that brought it. */
type FromModule<T> = T & { module: AssistantModule };

/**
 * Everything deployment needs to know about an installation's composition.
 *
 * Every field is consumed: CI builds images from `workers`, the provisioner
 * enables `gcpApis` and creates `schedulerJobs`, and the wizard renders
 * `billing`. Deriving them all from module metadata is what stops bash from
 * re-parsing `ASSISTANT_MODULES` and drifting from the schema.
 */
export interface DeploymentPlan {
  modules: readonly AssistantModule[];
  /** Worker images by name, including the ones this installation excludes. */
  workers: Readonly<Record<string, boolean>>;
  gcpApis: readonly string[];
  schedulerJobs: readonly FromModule<ModuleSchedulerJob>[];
  billing: {
    gcp: readonly FromModule<ModuleBillingLine>[];
    external: readonly FromModule<ModuleExternalCost>[];
  };
}

/**
 * @param metas the modules this build contains, from `assistant.config.ts`.
 * There is deliberately no default: a plan covering every module in the
 * repository would describe an installation nobody composed, which is the drift
 * this mechanism exists to prevent.
 */
export function deploymentPlan(config: Config, metas: readonly ModuleMeta[]): DeploymentPlan {
  const installed = metas.filter((meta) => isModuleEnabled(config, meta.name));

  // Every worker key stays present, so a module this installation excludes
  // yields an explicit false rather than a key the deploy workflow must guess.
  const workers: Record<string, boolean> = {};
  for (const meta of metas) {
    const image = meta.infra?.workerImage;
    if (image) workers[image] = installed.includes(meta);
  }

  /** Collect a repeated declaration across installed modules, tagged by module. */
  const fromInstalled = <T>(pick: (meta: ModuleMeta) => readonly T[] | undefined) =>
    installed.flatMap((meta) => (pick(meta) ?? []).map((item) => ({ ...item, module: meta.name })));

  return {
    modules: installed.map((meta) => meta.name),
    workers,
    gcpApis: installed.flatMap((meta) => meta.infra?.gcpApis ?? []),
    schedulerJobs: fromInstalled((meta) => meta.infra?.schedulerJobs),
    billing: {
      gcp: fromInstalled((meta) => meta.billing.gcp),
      external: fromInstalled((meta) => meta.billing.external),
    },
  };
}

/**
 * Human-readable cost explanation. Vendor-billed services come first because
 * they are the ones needing an account before anything can be deployed at all.
 */
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

  if (lines.length === 0) return 'These modules add no infrastructure or vendor cost.';
  return lines.join('\n');
}
