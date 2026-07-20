import { describe, expect, it, vi } from 'vitest';
import { cleanImportFileName, registerStagedImport, stagedImportPath } from './import-upload.js';

describe('import upload staging', () => {
  it('gives repeated filenames immutable, non-aliasing paths', () => {
    const cleanName = cleanImportFileName('My Archive?.zip');
    expect(cleanName).toBe('My_Archive_.zip');
    expect(stagedImportPath(cleanName, 'upload-one')).toBe(
      'import/uploads/upload-one-My_Archive_.zip',
    );
    expect(stagedImportPath(cleanName, 'upload-two')).not.toBe(
      stagedImportPath(cleanName, 'upload-one'),
    );
  });

  it('deletes staged content if source registration rejects it', async () => {
    const workspace = {
      write: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const failure = new Error('import is already running');

    await expect(
      registerStagedImport(workspace, 'import/uploads/unique-archive.zip', 'contents', async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(workspace.write).toHaveBeenCalledOnce();
    expect(workspace.delete).toHaveBeenCalledWith('import/uploads/unique-archive.zip');
  });
});
