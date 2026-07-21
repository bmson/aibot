import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { JobStorageConfig } from './input.js';

const MAX_BLOB_BYTES = 25 * 1024 * 1024;
const METADATA_TIMEOUT_MS = 5_000;
const STORAGE_TIMEOUT_MS = 60_000;

/** Binary blob store: local FS in dev, GCS JSON API (metadata-server token) in prod. */
export interface BlobStore {
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

  private async canonicalRoot(): Promise<string> {
    await mkdir(this.root, { recursive: true });
    return realpath(this.root);
  }

  private assertInside(root: string, target: string): string {
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      throw new Error('blob path resolves outside the store root');
    }
    return target;
  }

  async put(rel: string, data: Buffer): Promise<void> {
    if (data.length > MAX_BLOB_BYTES) throw new Error(`blob exceeds ${MAX_BLOB_BYTES} bytes`);
    const root = await this.canonicalRoot();
    const target = path.join(root, safeRel(rel));
    await mkdir(path.dirname(target), { recursive: true });
    this.assertInside(root, await realpath(path.dirname(target)));
    const info = await lstat(target).catch((error) => {
      if ((error as { code?: string }).code === 'ENOENT') return null;
      throw error;
    });
    if (info?.isSymbolicLink()) throw new Error('blob writes through symlinks are blocked');
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
      {
        headers: { 'Metadata-Flavor': 'Google' },
        signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
      },
    );
    if (!res.ok) throw new Error(`metadata token fetch failed: ${res.status}`);
    return ((await res.json()) as { access_token: string }).access_token;
  }

  private object(rel: string): string {
    return `${this.prefix}/${safeRel(rel)}`.replace(/^\/+/, '');
  }

  async put(rel: string, data: Buffer, contentType: string): Promise<void> {
    if (data.length > MAX_BLOB_BYTES) throw new Error(`blob exceeds ${MAX_BLOB_BYTES} bytes`);
    const res = await fetch(
      `https://storage.googleapis.com/upload/storage/v1/b/${this.bucket}/o?uploadType=media&name=${encodeURIComponent(this.object(rel))}`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${await this.token()}`, 'content-type': contentType },
        body: new Uint8Array(data),
        signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
      },
    );
    if (!res.ok) throw new Error(`gcs put failed: ${res.status} ${await res.text()}`);
  }
}

export function buildWorkspace(config: JobStorageConfig): BlobStore {
  if (config.driver === 'gcs') {
    if (!config.bucket || !config.prefix) throw new Error('gcs storage needs bucket + prefix');
    return new GcsBlobStore(config.bucket, config.prefix);
  }
  if (!config.root) throw new Error('local storage needs a root dir');
  return new LocalBlobStore(config.root);
}
