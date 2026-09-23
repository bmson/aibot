import type { WorkspaceCapabilityRepository } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { listMobileWorkspaceCapabilities } from './workspace-capabilities.js';

const modules = [
  { name: 'google', title: 'Google', summary: 'Mail and calendar' },
  { name: 'search', title: 'Search', summary: 'Web search' },
  { name: 'sms', title: 'SMS', summary: 'Text messages' },
] as const;

describe('mobile workspace capability projection', () => {
  it('uses live agent diagnostics for exact fields and status labels', async () => {
    const load = vi.fn<WorkspaceCapabilityRepository['load']>().mockResolvedValue({
      statusAvailable: true,
      diagnostics: [
        { module: 'google', enabled: true, ready: true, detail: 'ready' },
        { module: 'search', enabled: true, ready: false, detail: 'search key missing' },
        { module: 'sms', enabled: false, ready: false, detail: 'disabled' },
      ],
    });
    const repository: WorkspaceCapabilityRepository = {
      kind: 'workspace-capability-repository',
      load,
    };

    expect(await listMobileWorkspaceCapabilities(repository, 'owner', modules, ['google'])).toEqual(
      [
        {
          id: 'google',
          title: 'Google',
          summary: 'Mail and calendar',
          enabled: true,
          ready: true,
          status: 'ready',
          detail: 'ready',
        },
        {
          id: 'search',
          title: 'Search',
          summary: 'Web search',
          enabled: true,
          ready: false,
          status: 'setup_needed',
          detail: 'search key missing',
        },
        {
          id: 'sms',
          title: 'SMS',
          summary: 'Text messages',
          enabled: false,
          ready: false,
          status: 'off',
          detail: 'disabled',
        },
      ],
    );
    expect(load).toHaveBeenCalledExactlyOnceWith('owner', ['google', 'search', 'sms']);
  });

  it('marks enabled modules unavailable when the agent is offline or incomplete', async () => {
    const load = vi.fn<WorkspaceCapabilityRepository['load']>().mockResolvedValue({
      statusAvailable: false,
      diagnostics: [],
    });
    const repository: WorkspaceCapabilityRepository = {
      kind: 'workspace-capability-repository',
      load,
    };
    const projected = await listMobileWorkspaceCapabilities(repository, 'owner', modules, [
      'google',
      'search',
    ]);
    expect(projected.map((row) => [row.status, row.ready, row.detail])).toEqual([
      ['unavailable', false, 'agent readiness unavailable'],
      ['unavailable', false, 'agent readiness unavailable'],
      ['off', false, 'agent readiness unavailable'],
    ]);

    load.mockResolvedValue({
      statusAvailable: true,
      diagnostics: [{ module: 'google', enabled: true, ready: true, detail: 'ready' }],
    });
    const incomplete = await listMobileWorkspaceCapabilities(repository, 'owner', modules, [
      'google',
    ]);
    expect(incomplete.find((row) => row.id === 'google')?.status).toBe('unavailable');
  });
});
