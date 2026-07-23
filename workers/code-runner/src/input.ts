/**
 * Job input — arrives as the CODE_JOB_INPUT env var, produced by the agent's
 * launcher. This worker deliberately does NOT depend on @assistant/core (no DB
 * creds, no model SDKs in the image), so the spec shape is a minimal structural
 * copy of core's CodeSpecSchema.
 */

export interface CodeInput {
  workspacePath: string;
  as: string;
}

export interface CodeSpec {
  goal: string;
  language: 'javascript' | 'python';
  source: string;
  inputs?: CodeInput[];
  allowNetwork: boolean;
  timeoutSeconds: number;
}

/** Workspace areas an input may be staged from — mirrors core's CODE_INPUT_PREFIXES. */
export const CODE_INPUT_PREFIXES = ['code/', 'browser/attachments/', 'documents/', 'imports/'];

export interface JobStorageConfig {
  driver: 'gcs' | 'local';
  bucket?: string;
  prefix?: string;
  root?: string;
}

export interface JobInput {
  taskId: string;
  spec: CodeSpec;
  callbackUrl: string;
  callbackToken: string;
  storage: JobStorageConfig;
}

export function parseJobInput(raw: string | undefined): JobInput {
  if (!raw) throw new Error('CODE_JOB_INPUT is not set');
  const input = JSON.parse(raw) as JobInput;
  if (!input.taskId || !input.callbackUrl || !input.callbackToken) {
    throw new Error('job input missing taskId/callbackUrl/callbackToken');
  }
  if (!input.spec || typeof input.spec.source !== 'string' || input.spec.source.length === 0) {
    throw new Error('job input has no source');
  }
  if (input.spec.language !== 'javascript' && input.spec.language !== 'python') {
    throw new Error(`unsupported language: ${input.spec.language}`);
  }
  if (!input.storage?.driver) throw new Error('job input missing storage config');
  return input;
}
