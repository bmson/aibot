import type { AssistantModule, Config } from '@assistant/config';

/**
 * A configuration key a module owns. Modules pick from the single flat schema in
 * `@assistant/config` rather than contributing their own, so one environment
 * variable name keeps mapping to one Secret Manager entry.
 */
export type ConfigKey = keyof Config;

export interface ModuleReadiness {
  ready: boolean;
  /** Secret-safe explanation: presence and absence only, never a value. */
  detail: string;
}

/** A Cloud Run Job image built and provisioned only when the module is enabled. */
export interface ModuleWorker {
  /** Key emitted by `pnpm modules:plan` and consumed by the deploy workflow. */
  planKey: string;
  image: string;
  dockerfile: string;
  jobNameKey: ConfigKey;
  serviceAccount: string;
  /** Workspace prefixes the job's service account may read and write. */
  storagePrefixes?: readonly string[];
}

export interface ModuleSchedulerJob {
  name: string;
  /** Cron expression in the deployment region's Cloud Scheduler. */
  schedule: string;
  /** Internal agent route the job invokes with a route-scoped OIDC token. */
  path: string;
}

/**
 * Infrastructure a module requires. Deployment derives its resource plan from
 * these declarations so provisioning has one source of truth with composition.
 */
export interface ModuleInfra {
  worker?: ModuleWorker;
  /** Google APIs to enable beyond the always-on platform set. */
  gcpApis?: readonly string[];
  pubsubTopics?: readonly string[];
  schedulerJobs?: readonly ModuleSchedulerJob[];
  serviceAccounts?: readonly { id: string; displayName: string }[];
  /** Config keys stored in Secret Manager rather than the revision environment. */
  secretKeys?: readonly ConfigKey[];
}

export interface ModuleBillingLine {
  service: string;
  /**
   * `free-tier-likely` means a single-owner installation normally stays inside
   * the always-free allowance; `usage` means the module bills with activity.
   */
  tier: 'free-tier-likely' | 'usage';
  note: string;
}

export interface ModuleExternalCost {
  vendor: string;
  /** True when the module cannot function without a paid third-party account. */
  required: boolean;
  note: string;
  url?: string;
}

/**
 * What enabling this module costs. The setup wizard renders these before it
 * provisions anything, so the billing explanation is generated from the same
 * declarations that drive provisioning and cannot drift from them.
 */
export interface ModuleBilling {
  gcp?: readonly ModuleBillingLine[];
  external?: readonly ModuleExternalCost[];
}

export interface ModuleNavItem {
  href: string;
  label: string;
}

/**
 * Everything about a module that is plain data. Metadata carries no provider
 * code, so the web app, deployment scripts, and diagnostics can import it
 * without pulling tool implementations into their bundles.
 */
export interface ModuleMeta {
  name: AssistantModule;
  title: string;
  summary: string;
  /** Configuration this module reads. Used by diagnostics and deployment. */
  configKeys: readonly ConfigKey[];
  /**
   * Readiness of an enabled module. Omit when a module has no settings that can
   * be missing — the platform then reports it ready.
   */
  readiness?: (config: Config) => ModuleReadiness;
  /**
   * Problems that make a cloud installation broken, including the case where
   * this module is disabled but another setting requires it. Evaluated for
   * disabled modules too, and only for cloud-shaped configurations.
   */
  prodProblems?: (config: Config) => string[];
  infra?: ModuleInfra;
  billing: ModuleBilling;
  /** Navigation the web app reveals when the module is enabled. */
  ui?: { nav?: readonly ModuleNavItem[] };
  /**
   * Code-job names this module owns. Declared in metadata rather than at
   * runtime so the platform can recognise a job belonging to a module that is
   * not installed and complete it benignly instead of dead-lettering it.
   */
  jobs?: readonly string[];
}

/** Identity helper that keeps module metadata literals type-checked. */
export function defineModuleMeta(meta: ModuleMeta): ModuleMeta {
  return meta;
}
