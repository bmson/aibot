/**
 * Job input — arrives as the BROWSER_JOB_INPUT env var, produced by the agent's
 * launcher. This worker deliberately does NOT depend on @assistant/core (no DB
 * creds, no model SDKs in the image), so the plan shape is kept as a minimal
 * structural copy of core's BrowserPlanSchema; unknown actions fail per-step.
 */

export interface BrowserStep {
  action:
    | 'goto'
    | 'waitFor'
    | 'extract'
    | 'screenshot'
    | 'scroll'
    | 'click'
    | 'type'
    | 'select'
    | 'press';
  url?: string;
  selector?: string;
  text?: string;
  value?: string;
  key?: string;
  name?: string;
  what?: string;
  note?: string;
}

export interface BrowserPlan {
  goal: string;
  rung: string;
  steps: BrowserStep[];
  useProfile: boolean;
  maxDurationSeconds: number;
}

export interface JobStorageConfig {
  driver: 'gcs' | 'local';
  bucket?: string;
  prefix?: string;
  tracesBucket?: string;
  tracesPrefix?: string;
  root?: string;
}

export interface JobInput {
  taskId: string;
  plan: BrowserPlan;
  callbackUrl: string;
  callbackToken: string;
  storage: JobStorageConfig;
}

export function parseJobInput(raw: string | undefined): JobInput {
  if (!raw) throw new Error('BROWSER_JOB_INPUT is not set');
  const input = JSON.parse(raw) as JobInput;
  if (!input.taskId || !input.callbackUrl || !input.callbackToken) {
    throw new Error('job input missing taskId/callbackUrl/callbackToken');
  }
  if (!input.plan || !Array.isArray(input.plan.steps) || input.plan.steps.length === 0) {
    throw new Error('job input has no plan steps');
  }
  if (!input.storage?.driver) throw new Error('job input missing storage config');
  return input;
}
