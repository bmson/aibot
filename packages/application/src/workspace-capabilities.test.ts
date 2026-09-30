import type { WorkspaceCapabilityRepository } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import {
  listMobileWorkspaceCapabilities,
  visibleWorkspaceCapabilityModules,
} from './workspace-capabilities.js';

const modules = [
  { name: 'google', title: 'Google', summary: 'Mail and calendar' },
  { name: 'search', title: 'Search', summary: 'Web search' },
  { name: 'sms', title: 'SMS', summary: 'Text messages' },
] as const;

describe('mobile workspace capability projection', () => {
  const overlappingModules = [
    { name: 'calendar', title: 'Google Calendar', summary: 'Calendar reads' },
    { name: 'google', title: 'Google Workspace', summary: 'Mail and calendar' },
    { name: 'maps', title: 'Apple Maps', summary: 'Directions' },
  ];

  it('removes duplicate Calendar using live agent enablement and keeps Maps visible', async () => {
    const repository: WorkspaceCapabilityRepository = {
      kind: 'workspace-capability-repository',
      load: vi.fn().mockResolvedValue({
        statusAvailable: true,
        diagnostics: overlappingModules.map(({ name }) => ({
          module: name,
          enabled: name === 'google',
          ready: name === 'google',
          detail: name === 'google' ? 'ready' : 'disabled',
        })),
      }),
    };
    // The web service's config must not override the agent's live enablement.
    const projected = await listMobileWorkspaceCapabilities(
      repository,
      'owner',
      overlappingModules,
      ['calendar', 'maps'],
    );
    expect(projected.map((row) => [row.id, row.status])).toEqual([
      ['google', 'ready'],
      ['maps', 'off'],
    ]);
  });

  it('keeps standalone Calendar and enabled Maps with their actual readiness', async () => {
    const repository: WorkspaceCapabilityRepository = {
      kind: 'workspace-capability-repository',
      load: vi.fn().mockResolvedValue({
        statusAvailable: true,
        diagnostics: [
          { module: 'calendar', enabled: true, ready: true, detail: 'ready' },
          { module: 'google', enabled: false, ready: false, detail: 'disabled' },
          { module: 'maps', enabled: true, ready: false, detail: 'missing MapKit key' },
        ],
      }),
    };
    const projected = await listMobileWorkspaceCapabilities(
      repository,
      'owner',
      overlappingModules,
      [],
    );
    expect(projected.map((row) => [row.id, row.status])).toEqual([
      ['calendar', 'ready'],
      ['google', 'off'],
      ['maps', 'setup_needed'],
    ]);
    expect(projected.find((row) => row.id === 'maps')?.detail).toBe('missing MapKit key');
  });

  it('retains ready Maps and does not hide integrations with unknown enablement', () => {
    expect(
      visibleWorkspaceCapabilityModules(overlappingModules, [
        { module: 'google', enabled: true },
        { module: 'maps', enabled: true },
      ]).map((row) => row.name),
    ).toEqual(['google', 'maps']);
    expect(visibleWorkspaceCapabilityModules(overlappingModules, [])).toEqual(overlappingModules);
  });

  it('uses configured enablement when readiness is unavailable without inventing Ready', async () => {
    const repository: WorkspaceCapabilityRepository = {
      kind: 'workspace-capability-repository',
      load: vi.fn().mockResolvedValue({ statusAvailable: false, diagnostics: [] }),
    };
    const projected = await listMobileWorkspaceCapabilities(
      repository,
      'owner',
      overlappingModules,
      ['google', 'maps'],
    );
    expect(projected.map((row) => [row.id, row.status])).toEqual([
      ['google', 'unavailable'],
      ['maps', 'unavailable'],
    ]);
  });

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
