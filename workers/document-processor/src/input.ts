/**
 * Job input — arrives as the DOCUMENT_JOB_INPUT env var, produced by the agent's
 * processor launcher. This worker deliberately does NOT depend on @assistant/core
 * (no DB creds, no model SDKs in the image); it only ever reads bytes from the
 * Workspace and writes extracted text back.
 */

export interface JobStorageConfig {
  driver: 'gcs' | 'local';
  bucket?: string;
  prefix?: string;
  root?: string;
}

export interface JobInput {
  documentId: string;
  source: { workspacePath: string; mime: string; title: string; extractor: string };
  /** Where the extracted text is uploaded (relative to the Workspace prefix). */
  outputPath: string;
  callbackUrl: string;
  callbackToken: string;
  storage: JobStorageConfig;
}

export function parseJobInput(raw: string | undefined): JobInput {
  if (!raw) throw new Error('DOCUMENT_JOB_INPUT is not set');
  const input = JSON.parse(raw) as JobInput;
  if (!input.documentId || !input.callbackUrl || !input.callbackToken) {
    throw new Error('job input missing documentId/callbackUrl/callbackToken');
  }
  if (!input.source?.workspacePath) throw new Error('job input missing source.workspacePath');
  if (!input.outputPath) throw new Error('job input missing outputPath');
  if (!input.storage?.driver) throw new Error('job input missing storage config');
  return input;
}
