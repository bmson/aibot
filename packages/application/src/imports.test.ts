import type { ImportOverviewRepository, Records } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { getImportOverview } from './imports.js';
import type { WorkspacePort } from './workspace.js';

const now = new Date('2026-09-22T12:00:00Z');

function source(
  id: string,
  name: string,
  workspacePath: string,
  updatedAt: Date,
): Records['importSources'] {
  return {
    id,
    agentId: 'owner',
    createdAt: now,
    updatedAt,
    source: name,
    workspacePath,
    kind: 'text',
    status: 'done',
    taskId: null,
    itemsTotal: 1,
    itemsProcessed: 1,
    memoriesSaved: 1,
    memoriesQuarantined: 0,
    error: null,
  };
}

describe('import overview application seam', () => {
  it('preserves source ordering, voice filtering, per-source counts, and unstarted files', async () => {
    const latest = source('latest', 'takeout-mail', 'import/latest.txt', now);
    const voice = source('voice', 'voice-samples-upload', 'import/voice.txt', new Date(1));
    const repository: ImportOverviewRepository = {
      kind: 'import-overview-repository',
      load: vi.fn().mockResolvedValue({
        sources: [voice, latest],
        quarantineBySource: { 'takeout-mail': 2, 'voice-samples-upload': 1 },
      }),
    };
    const workspace = {
      list: vi.fn().mockResolvedValue([
        { name: 'latest.txt', dir: false },
        { name: 'voice.txt', dir: false },
        { name: 'new.txt', dir: false },
        { name: 'folder', dir: true },
      ]),
    } as unknown as WorkspacePort;

    await expect(getImportOverview(repository, workspace)).resolves.toEqual({
      sources: [latest],
      quarantineBySource: { 'takeout-mail': 2, 'voice-samples-upload': 1 },
      unstartedFiles: [{ name: 'new.txt', dir: false }],
    });
    expect(repository.load).toHaveBeenCalledOnce();
    expect(workspace.list).toHaveBeenCalledWith('import');
  });

  it('keeps workspace listing best-effort without changing database source data', async () => {
    const row = source('known', 'source', 'import/known.txt', now);
    const repository: ImportOverviewRepository = {
      kind: 'import-overview-repository',
      load: vi.fn().mockResolvedValue({ sources: [row], quarantineBySource: {} }),
    };
    const workspace = {
      list: vi.fn().mockRejectedValue(new Error('offline')),
    } as unknown as WorkspacePort;

    await expect(getImportOverview(repository, workspace)).resolves.toEqual({
      sources: [row],
      quarantineBySource: {},
      unstartedFiles: [],
    });
  });
});
