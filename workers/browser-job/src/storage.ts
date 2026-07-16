import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { JobStorageConfig } from './input.js';

/** Binary blob store: local FS in dev, GCS JSON API (metadata-server token) in prod. */
export interface BlobStore {
  get(relPath: string): Promise<Buffer | null>;
  put(relPath: string, data: Buffer, contentType: string): Promise<void>;
}

function safeRel(rel: string): string {
  const normalized = path.posix.normalize(rel.replaceAll('\\', '/')).replace(/^\/+/, '');
  if (normalized.startsWith('..') || normalized.includes('/../')) {
    throw new Error('path escapes the store root');
  }
  return normalized;
}

class LocalBlobStore implements BlobStore {
  constructor(private root: string) {}

  async get(rel: string): Promise<Buffer | null> {
    try {
      return await readFile(path.join(this.root, safeRel(rel)));
    } catch {
      return null;
    }
  }

  async put(rel: string, data: Buffer): Promise<void> {
    const target = path.join(this.root, safeRel(rel));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
  }
}

class GcsBlobStore implements BlobStore {
  constructor(
    private bucket: string,
    private prefix: string,
  ) {}

  private async token(): Promise<string> {
    const res = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' } },
    );
    if (!res.ok) throw new Error(`metadata token fetch failed: ${res.status}`);
    return ((await res.json()) as { access_token: string }).access_token;
  }

  private object(rel: string): string {
    return `${this.prefix}/${safeRel(rel)}`.replace(/^\/+/, '');
  }

  async get(rel: string): Promise<Buffer | null> {
    const res = await fetch(
      `https://storage.googleapis.com/storage/v1/b/${this.bucket}/o/${encodeURIComponent(this.object(rel))}?alt=media`,
      { headers: { authorization: `Bearer ${await this.token()}` } },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`gcs get failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async put(rel: string, data: Buffer, contentType: string): Promise<void> {
    const res = await fetch(
      `https://storage.googleapis.com/upload/storage/v1/b/${this.bucket}/o?uploadType=media&name=${encodeURIComponent(this.object(rel))}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await this.token()}`,
          'content-type': contentType,
        },
        body: new Uint8Array(data),
      },
    );
    if (!res.ok) throw new Error(`gcs put failed: ${res.status} ${await res.text()}`);
  }
}

export interface JobStores {
  /** The agent's Workspace (profile tarball, screenshots). */
  workspace: BlobStore;
  /** Trace archives (separate 30-day-lifecycle bucket in prod). */
  traces: BlobStore;
}

export function buildStores(config: JobStorageConfig): JobStores {
  if (config.driver === 'gcs') {
    if (!config.bucket || !config.prefix) throw new Error('gcs storage needs bucket + prefix');
    const workspace = new GcsBlobStore(config.bucket, config.prefix);
    const traces =
      config.tracesBucket && config.tracesPrefix
        ? new GcsBlobStore(config.tracesBucket, config.tracesPrefix)
        : workspace;
    return { workspace, traces };
  }
  if (!config.root) throw new Error('local storage needs a root dir');
  const workspace = new LocalBlobStore(config.root);
  return { workspace, traces: workspace };
}
