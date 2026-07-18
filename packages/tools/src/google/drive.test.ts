import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../registry.js';
import type { AssistantTool, ToolContext } from '../types.js';
import { registerDriveTools, safeAttachmentName } from './drive.js';

function tool(registry: ToolRegistry, name: string): AssistantTool {
  const registered = registry.get(name);
  if (!registered) throw new Error(`missing ${name}`);
  return registered.tool;
}

const context = {
  taskId: 'task-1',
  agentId: 'agent-1',
  trust: 'owner',
  tainted: false,
  db: {},
  now: () => new Date(),
  signal: new AbortController().signal,
  log: async () => {},
} as unknown as ToolContext;

describe('Drive attachment tools', () => {
  it('stages a Google Doc as a Workspace PDF without uploading it anywhere', async () => {
    const api = vi.fn(async () => ({
      id: 'doc_1234567890',
      name: 'Baldvin résumé',
      mimeType: 'application/vnd.google-apps.document',
      webViewLink: 'https://docs.google.com/document/d/doc_1234567890/edit',
    }));
    const apiBytes = vi.fn(async () => ({
      body: Buffer.from('%PDF'),
      contentType: 'application/pdf',
    }));
    const writeBytes = vi.fn(async () => ({ bytes: 4 }));
    const registry = registerDriveTools(new ToolRegistry(), {
      client: { api, apiBytes } as never,
      workspace: { writeBytes } as never,
    });

    const result = await tool(registry, 'drive.download').execute(
      { fileId: 'doc_1234567890' },
      context,
    );

    expect(apiBytes).toHaveBeenCalledWith(
      'https://www.googleapis.com/drive/v3/files/doc_1234567890/export?mimeType=application%2Fpdf',
    );
    expect(writeBytes).toHaveBeenCalledWith(
      'browser/attachments/Baldvin_r_sum_.pdf',
      Buffer.from('%PDF'),
      'application/pdf',
    );
    expect(result).toMatchObject({
      workspacePath: 'browser/attachments/Baldvin_r_sum_.pdf',
      exportedAsPdf: true,
      bytes: 4,
    });
  });

  it('sanitizes generated attachment names and preserves safe extensions', () => {
    expect(safeAttachmentName('../../Baldvin résumé.pdf')).toBe('Baldvin_r_sum_.pdf');
    expect(safeAttachmentName('   ')).toBe('attachment');
  });

  it('rejects staging paths outside the browser attachment area', async () => {
    const registry = registerDriveTools(new ToolRegistry(), {
      client: { api: vi.fn(), apiBytes: vi.fn() } as never,
      workspace: { writeBytes: vi.fn() } as never,
    });

    await expect(
      tool(registry, 'drive.download').execute(
        { fileId: 'doc_1234567890', workspacePath: 'browser/profile.tar.enc' },
        context,
      ),
    ).rejects.toThrow(/browser\/attachments/);
  });
});
