import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  owner: vi.fn(),
  identity: vi.fn(),
  refresh: vi.fn(),
  revalidate: vi.fn(),
  cardRefresh: {},
}));
vi.mock('@/auth', () => ({ requireOwner: mocks.owner }));
vi.mock('@/lib/server', () => ({
  getAgentIdentity: mocks.identity,
  getCardRefresh: () => mocks.cardRefresh,
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('@assistant/application/cards', () => ({
  requestSavedCardRefresh: mocks.refresh,
  dismissSavedCard: vi.fn(),
}));

import { refreshSavedCardInline } from './actions';

const id = '11111111-2222-4333-8444-555555555555';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.owner.mockResolvedValue(undefined);
  mocks.identity.mockResolvedValue({ id: 'owner-agent' });
  mocks.refresh.mockResolvedValue({ ok: true, taskId: 'task-1', refreshState: 'refreshing' });
});

describe('saved-card refresh action', () => {
  it('authenticates before queueing and scopes the request to the signed-in agent', async () => {
    await expect(refreshSavedCardInline(id)).resolves.toEqual({ ok: true, taskId: 'task-1' });
    expect(mocks.owner).toHaveBeenCalledOnce();
    expect(mocks.refresh).toHaveBeenCalledWith(mocks.cardRefresh, 'owner-agent', id);
    expect(mocks.revalidate).toHaveBeenCalledWith('/chat', 'layout');
  });
  it('does not refresh without owner authentication or a valid card id', async () => {
    mocks.owner.mockRejectedValueOnce(new Error('Unauthorized'));
    await expect(refreshSavedCardInline(id)).rejects.toThrow('Unauthorized');
    expect(mocks.refresh).not.toHaveBeenCalled();
    await expect(refreshSavedCardInline('not-a-card-id')).resolves.toMatchObject({ ok: false });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it('reports rejected refreshes rather than claiming work started', async () => {
    mocks.refresh.mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: 'This saved card is unavailable.',
    });
    await expect(refreshSavedCardInline(id)).resolves.toEqual({
      ok: false,
      error: 'This saved card is unavailable.',
    });
  });
});
