import { randomUUID } from 'node:crypto';
import { safeRelPath } from '@assistant/tools';

export interface UploadWorkspace {
  write(relPath: string, content: string): Promise<unknown>;
  delete(relPath: string): Promise<void>;
}

export function cleanImportFileName(fileName: string): string {
  return fileName.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'archive.txt';
}

/** Every upload gets an immutable source path; filenames are display metadata, not identity. */
export function stagedImportPath(cleanName: string, uploadId: string = randomUUID()): string {
  return safeRelPath(`import/uploads/${uploadId}-${cleanName}`);
}

/** Remove an unpublished upload when database registration fails. */
export async function registerStagedImport<T>(
  workspace: UploadWorkspace,
  workspacePath: string,
  content: string,
  register: () => Promise<T>,
): Promise<T> {
  await workspace.write(workspacePath, content);
  try {
    return await register();
  } catch (error) {
    await workspace.delete(workspacePath).catch(() => {});
    throw error;
  }
}
