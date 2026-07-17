import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

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

  private resolve(rel: string): string {
    return path.join(this.root, safeRelPath(rel));
  }

  async read(rel: string): Promise<string> {
    return readFile(this.resolve(rel), 'utf8');
  }

  async write(rel: string, content: string): Promise<{ bytes: number }> {
    const target = this.resolve(rel);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
    return { bytes: Buffer.byteLength(content) };
  }

  async list(rel: string): Promise<Array<{ name: string; dir: boolean }>> {
    const entries = await readdir(this.resolve(rel || '.'), { withFileTypes: true }).catch(
      () => [],
    );
    return entries.map((e) => ({ name: e.name, dir: e.isDirectory() }));
  }

  async delete(rel: string): Promise<void> {
    await rm(this.resolve(rel), { force: true });
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
      { headers: { 'Metadata-Flavor': 'Google' } },
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
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (res.status === 404) throw new Error(`no such file: ${rel}`);
    if (!res.ok) throw new Error(`gcs read failed: ${res.status}`);
    return res.text();
  }

  async write(rel: string, content: string): Promise<{ bytes: number }> {
    const token = await this.token();
    const res = await fetch(
      `https://storage.googleapis.com/upload/storage/v1/b/${this.bucket}/o?uploadType=media&name=${encodeURIComponent(this.object(rel))}`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' },
        body: content,
      },
    );
    if (!res.ok) throw new Error(`gcs write failed: ${res.status} ${await res.text()}`);
    return { bytes: Buffer.byteLength(content) };
  }

  async delete(rel: string): Promise<void> {
    const token = await this.token();
    const res = await fetch(
      `https://storage.googleapis.com/storage/v1/b/${this.bucket}/o/${encodeURIComponent(this.object(rel))}`,
      { method: 'DELETE', headers: { authorization: `Bearer ${token}` } },
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
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
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
