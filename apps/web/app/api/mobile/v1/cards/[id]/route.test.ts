import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  refresh: vi.fn(),
  dismiss: vi.fn(),
  identity: vi.fn(),
  refreshRepository: {},
  cards: {},
}));
vi.mock('@assistant/application/cards', () => ({
  requestSavedCardRefresh: mocks.refresh,
  dismissSavedCard: mocks.dismiss,
}));
vi.mock('@/lib/server', () => ({
  getCardRefresh: () => mocks.refreshRepository,
  getGeneratedCards: () => mocks.cards,
  getAgentIdentity: mocks.identity,
}));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: mocks.auth,
  mobileJson: (body: unknown, init?: ResponseInit) => Response.json(body, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));

import { POST } from './route';

const id = '33333333-3333-4333-8333-333333333333';
const post = (action: unknown = 'refresh', cardId = id) =>
  POST(
    new Request(`https://example.test/api/mobile/v1/cards/${cardId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    }),
    { params: Promise.resolve({ id: cardId }) },
  );

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue(true);
  mocks.identity.mockResolvedValue({ id: 'owner-agent' });
});

describe('saved card refresh transport', () => {
  it('authenticates before resolving or changing a card', async () => {
    mocks.auth.mockResolvedValue(false);
    expect((await post()).status).toBe(401);
    expect(mocks.identity).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('returns the queued task and uses server-owned identity', async () => {
    const result = { ok: true, taskId: 'refresh-task', refreshState: 'refreshing' };
    mocks.refresh.mockResolvedValue(result);
    const response = await post();
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual(result);
    expect(mocks.refresh).toHaveBeenCalledWith(mocks.refreshRepository, 'owner-agent', id);
    expect(mocks.dismiss).not.toHaveBeenCalled();
  });

  it.each([
    { status: 404, error: 'Card not found.' },
    { status: 409, error: 'This older card has no reliable source reference to refresh.' },
  ])('preserves actionable refresh failures ($status)', async ({ status, error }) => {
    mocks.refresh.mockResolvedValue({ ok: false, status, error });
    const response = await post();
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
  });

  it('rejects malformed IDs and unsupported actions without queueing work', async () => {
    expect((await post('refresh', 'invalid')).status).toBe(400);
    expect((await post('send')).status).toBe(400);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('preserves dismissal behavior', async () => {
    mocks.dismiss.mockResolvedValue(true);
    const response = await post('dismiss');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.dismiss).toHaveBeenCalledWith(mocks.cards, 'owner-agent', id);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
