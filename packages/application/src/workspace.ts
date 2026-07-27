import path from 'node:path';

export interface WorkspacePort {
  read(relativePath: string): Promise<string>;
  write(relativePath: string, content: string): Promise<unknown>;
  readBytes(relativePath: string): Promise<Buffer>;
  writeBytes(relativePath: string, content: Buffer, contentType: string): Promise<unknown>;
  list(relativePath: string): Promise<Array<{ name: string; dir: boolean }>>;
  delete(relativePath: string): Promise<void>;
}

/** Normalize an owner-controlled relative workspace path and reject traversal. */
export function safeWorkspacePath(relativePath: string): string {
  const normalized = path.posix.normalize(relativePath.replaceAll('\\', '/')).replace(/^\/+/, '');
  if (normalized.startsWith('..') || normalized.includes('/../')) {
    throw new Error('path escapes the workspace');
  }
  return normalized;
}
