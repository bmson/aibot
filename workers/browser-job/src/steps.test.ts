import type { Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';
import { runSteps } from './steps.js';
import type { BlobStore } from './storage.js';

describe('browser upload step', () => {
  it('attaches a staged Workspace binary directly to the approved file input', async () => {
    const setInputFiles = vi.fn(async () => {});
    const page = {
      locator: vi.fn(() => ({ first: () => ({ setInputFiles }) })),
    } as unknown as Page;
    const workspace = {
      get: vi.fn(async () => Buffer.from('%PDF')),
    } as unknown as BlobStore;

    const result = await runSteps(
      page,
      [
        {
          action: 'upload',
          selector: 'input[type=file]',
          workspacePath: 'browser/attachments/resume.pdf',
        },
      ],
      { taskId: 'task-1', workspace },
    );

    expect(workspace.get).toHaveBeenCalledWith('browser/attachments/resume.pdf');
    expect(setInputFiles).toHaveBeenCalledWith({
      name: 'resume.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF'),
    });
    expect(result.outputs).toMatchObject([{ action: 'upload', ok: true }]);
  });

  it('fails closed when the approved attachment is no longer available', async () => {
    const page = {
      locator: vi.fn(() => ({ first: () => ({ setInputFiles: vi.fn() }) })),
    } as unknown as Page;
    const workspace = { get: vi.fn(async () => undefined) } as unknown as BlobStore;

    const result = await runSteps(
      page,
      [
        {
          action: 'upload',
          selector: 'input[type=file]',
          workspacePath: 'browser/attachments/resume.pdf',
        },
      ],
      { taskId: 'task-1', workspace },
    );

    expect(result.failedAtStep).toBe(0);
    expect(result.outputs[0]?.error).toContain('attachment not found');
  });

  it('never reads the encrypted browser profile as an upload', async () => {
    const workspace = { get: vi.fn(async () => Buffer.from('secret')) } as unknown as BlobStore;
    const result = await runSteps(
      {} as Page,
      [
        {
          action: 'upload',
          selector: 'input[type=file]',
          workspacePath: 'browser/profile.tar.enc',
        },
      ],
      { taskId: 'task-1', workspace },
    );

    expect(workspace.get).not.toHaveBeenCalled();
    expect(result.outputs[0]?.error).toContain('browser/attachments');
  });
});
