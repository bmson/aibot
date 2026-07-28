import type { AssistantModule, Config } from '@assistant/config';

/**
 * The plain-data half of the module contract.
 *
 * Nothing here imports provider code, so the web app, deployment scripts, and
 * diagnostics can read module metadata without pulling tools, core, or the
 * database into their bundles. `scripts/check-boundaries.ts` enforces that.
 *
 * Every field below is consumed by something. Declaring infrastructure that no
 * code reads would leave the wizard confidently describing resources it does
 * not control, so a field is added here only once a consumer exists.
 */

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

/** A Cloud Scheduler job that calls one of the agent's internal routes. */
export interface ModuleSchedulerJob {
  name: string;
  /** Cron expression, evaluated in the deployment region. */
  schedule: string;
  /** Internal agent route invoked with a route-scoped OIDC token. */
  path: string;
}

/** Infrastructure a module needs, which deployment provisions when it is enabled. */
export interface ModuleInfra {
  /**
   * Name of the worker image to build, which is also this module's key in the
   * deployment plan. CI builds the image only when the module is composed in.
   */
  workerImage?: string;
  /** Google APIs to enable beyond the always-on platform set. */
  gcpApis?: readonly string[];
  schedulerJobs?: readonly ModuleSchedulerJob[];
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

/**
 * Everything about a module that is plain data.
 *
 * Declare metadata with `satisfies ModuleMeta` so the literal keeps its narrow
 * inferred type while still being checked against this contract.
 */
export interface ModuleMeta {
  name: AssistantModule;
  title: string;
  summary: string;
  /** Configuration this module reads. Diagnostics and deployment use it. */
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
  /** Routes the web shell hides while this module is not installed. */
  ui?: { navHrefs?: readonly string[] };
  /**
   * Code-job names this module owns, so a job queued before the module was
   * removed completes benignly instead of dead-lettering. Keep in step with
   * `CodeJobName` in `@assistant/core`.
   */
  jobs?: readonly string[];
}
