import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  config: {
    SELF_REPAIR_ENABLED: true,
    SELF_REPAIR_PROVIDER: 'openai_hosted',
    SELF_REPAIR_DAILY_LIMIT: 2,
    GITHUB_REPO: 'owner/repo',
    GITHUB_TOKEN: '',
  },
  service: vi.fn(),
  decide: vi.fn(),
  list: vi.fn(),
}));
vi.mock('@assistant/config', () => ({ loadConfig: () => state.config }));
vi.mock('@assistant/application', () => ({
  decideRepairIssue: state.decide,
  listRepairIssues: state.list,
  reportRepair: vi.fn(),
}));
vi.mock('./server', () => ({ getSelfRepairService: state.service }));

import { decideOwnerRepair, getSelfRepairOverview } from './self-repair-server';

const repository = {};
beforeEach(() => {
  vi.clearAllMocks();
  state.config.SELF_REPAIR_PROVIDER = 'openai_hosted';
  state.config.SELF_REPAIR_ENABLED = true;
  state.config.GITHUB_REPO = 'owner/repo';
  state.service.mockResolvedValue({ repository, agentId: 'owner' });
  state.list.mockResolvedValue([]);
});

it('shows hosted repair as configured without mounting agent credentials on web', async () => {
  expect(await getSelfRepairOverview()).toMatchObject({ configured: true, enabled: true });
  await decideOwnerRepair('issue', 'run_now');
  expect(state.decide).toHaveBeenCalledWith(repository, 'owner', 'issue', 'run_now');
});

it('keeps the legacy worker credential requirement', async () => {
  state.config.SELF_REPAIR_PROVIDER = 'github';
  expect(await getSelfRepairOverview()).toMatchObject({ configured: false });
  await expect(decideOwnerRepair('issue', 'run_now')).rejects.toThrow('Configure and enable');
  expect(state.decide).not.toHaveBeenCalled();
});

it.each(['disabled', 'missing repository'])(
  'blocks manual hosted dispatch when %s',
  async (reason) => {
    if (reason === 'disabled') state.config.SELF_REPAIR_ENABLED = false;
    else state.config.GITHUB_REPO = '';
    await expect(decideOwnerRepair('issue', 'run_now')).rejects.toThrow('Configure and enable');
    expect(state.decide).not.toHaveBeenCalled();
  },
);
