import { lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_WORKSPACE_READ_BYTES = 64 * 1024 * 1024;
const METADATA_TIMEOUT_MS = 5_000;
const STORAGE_TIMEOUT_MS = 60_000;

async function boundedResponseText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`workspace object exceeds ${maxBytes} bytes`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

/**
 * The assistant's Workspace file store. Local FS for dev; GCS in prod (Cloud
 * Run's filesystem is ephemeral). Browser profiles join this in Phase 6.
 */
export interface WorkspaceStore {
  read(relPath: string): Promise<string>;
  write(relPath: string, content: string): Promise<{ bytes: number }>;
  list(relPath: string): Promise<Array<{ name: string; dir: boolean }>>;
  /** Remove a file. Missing files are a no-op, not an error. */
  delete(relPath: string): Promise<void>;
}

/** Reject traversal; normalize to forward slashes. */
export function safeRelPath(rel: string): string {
  const normalized = path.posix.normalize(rel.replaceAll('\\', '/')).replace(/^\/+/, '');
  if (normalized.startsWith('..') || normalized.includes('/../')) {
    throw new Error('path escapes the workspace');
  }
  return normalized;
}

export class LocalWorkspaceStore implements WorkspaceStore {
  constructor(private root: string) {}

  private async canonicalRoot(): Promise<string> {
    await mkdir(this.root, { recursive: true });
    return realpath(this.root);
  }

  private assertInside(root: string, target: string): string {
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      throw new Error('workspace path resolves outside the workspace');
    }
    return target;
  }

  private async resolveExisting(rel: string): Promise<string> {
    const root = await this.canonicalRoot();
    return this.assertInside(root, await realpath(path.join(root, safeRelPath(rel))));
  }

  private async resolveWrite(rel: string): Promise<string> {
    const root = await this.canonicalRoot();
    const target = path.join(root, safeRelPath(rel));
    await mkdir(path.dirname(target), { recursive: true });
    this.assertInside(root, await realpath(path.dirname(target)));
    const info = await lstat(target).catch((error) => {
      if ((error as { code?: string }).code === 'ENOENT') return null;
      throw error;
    });
    if (info?.isSymbolicLink()) throw new Error('workspace writes through symlinks are blocked');
    return target;
  }

  async read(rel: string): Promise<string> {
    const target = await this.resolveExisting(rel);
    const info = await stat(target);
    if (info.size > MAX_WORKSPACE_READ_BYTES) {
      throw new Error(`workspace file exceeds ${MAX_WORKSPACE_READ_BYTES} bytes`);
    }
    return readFile(target, 'utf8');
  }

  async write(rel: string, content: string): Promise<{ bytes: number }> {
    const target = await this.resolveWrite(rel);
    await writeFile(target, content, 'utf8');
    return { bytes: Buffer.byteLength(content) };
  }

  async list(rel: string): Promise<Array<{ name: string; dir: boolean }>> {
    const target = await this.resolveExisting(rel || '.').catch((error) => {
      if ((error as { code?: string }).code === 'ENOENT') return null;
      throw error;
    });
    if (!target) return [];
    const entries = await readdir(target, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, dir: e.isDirectory() }));
  }

  async delete(rel: string): Promise<void> {
    const target = await this.resolveExisting(rel).catch((error) => {
      if ((error as { code?: string }).code === 'ENOENT') return null;
      throw error;
    });
    if (target) await rm(target, { force: true });
  }
}

/** GCS JSON API via the metadata-server token — no SDK. */
export class GcsWorkspaceStore implements WorkspaceStore {
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
    return `${this.prefix}/${safeRelPath(rel)}`.replace(/^\/+/, '');
  }

  async read(rel: string): Promise<string> {
    const token = await this.token();
    const res = await fetch(
      `https://storage.googleapis.com/storage/v1/b/${this.bucket}/o/${encodeURIComponent(this.object(rel))}?alt=media`,
      {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
      },
    );
    if (res.status === 404) throw new Error(`no such file: ${rel}`);
    if (!res.ok) throw new Error(`gcs read failed: ${res.status}`);
    return boundedResponseText(res, MAX_WORKSPACE_READ_BYTES);
  }

  async write(rel: string, content: string): Promise<{ bytes: number }> {
    const token = await this.token();
    const res = await fetch(
      `https://storage.googleapis.com/upload/storage/v1/b/${this.bucket}/o?uploadType=media&name=${encodeURIComponent(this.object(rel))}`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' },
        body: content,
        signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
      },
    );
    if (!res.ok) throw new Error(`gcs write failed: ${res.status} ${await res.text()}`);
    return { bytes: Buffer.byteLength(content) };
  }

  async delete(rel: string): Promise<void> {
    const token = await this.token();
    const res = await fetch(
      `https://storage.googleapis.com/storage/v1/b/${this.bucket}/o/${encodeURIComponent(this.object(rel))}`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
      },
    );
    if (!res.ok && res.status !== 404) {
      throw new Error(`gcs delete failed: ${res.status}`);
    }
  }

  async list(rel: string): Promise<Array<{ name: string; dir: boolean }>> {
    const token = await this.token();
    const dirPrefix = rel && rel !== '.' ? `${this.object(rel)}/` : `${this.prefix}/`;
    const url = new URL(`https://storage.googleapis.com/storage/v1/b/${this.bucket}/o`);
    url.searchParams.set('prefix', dirPrefix);
    url.searchParams.set('delimiter', '/');
    url.searchParams.set('maxResults', '100');
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`gcs list failed: ${res.status}`);
    const data = (await res.json()) as { items?: Array<{ name: string }>; prefixes?: string[] };
    return [
      ...(data.prefixes ?? []).map((p) => ({
        name: p.slice(dirPrefix.length).replace(/\/$/, ''),
        dir: true,
      })),
      ...(data.items ?? [])
        .filter((i) => i.name !== dirPrefix)
        .map((i) => ({ name: i.name.slice(dirPrefix.length), dir: false })),
    ];
  }
}
