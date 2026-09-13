import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  hide: vi.fn(),
  unhide: vi.fn(),
}));
vi.mock('@/lib/server', () => ({
  getApplication: () => ({
    hideChatMessage: mocks.hide,
    unhideChatMessage: mocks.unhide,
  }),
}));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: mocks.auth,
  mobileJson: (body: unknown, init?: ResponseInit) => Response.json(body, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));

import { POST } from './route';

const CHAT_ID = '11111111-1111-1111-1111-111111111111';
const MESSAGE_ID = '22222222-2222-2222-2222-222222222222';

const post = (id: string, messageId: string, body: unknown) =>
  POST(
    new Request(`https://example.com/api/mobile/v1/chats/${id}/messages/${messageId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id, messageId }) },
  );

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue(true);
});

describe('native chat message visibility', () => {
  it('requires authentication before touching anything', async () => {
    mocks.auth.mockResolvedValue(false);
    const response = await post(CHAT_ID, MESSAGE_ID, { action: 'hide' });
    expect(response.status).toBe(401);
    expect(mocks.hide).not.toHaveBeenCalled();
  });

  it('rejects a malformed chat id', async () => {
    const response = await post('not-a-uuid', MESSAGE_ID, { action: 'hide' });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('invalid chat id');
    expect(mocks.hide).not.toHaveBeenCalled();
  });

  it('rejects a malformed message id', async () => {
    const response = await post(CHAT_ID, 'not-a-uuid', { action: 'hide' });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('invalid message id');
    expect(mocks.hide).not.toHaveBeenCalled();
  });

  it('rejects a missing action', async () => {
    const response = await post(CHAT_ID, MESSAGE_ID, {});
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      'action must be hide or unhide',
    );
  });

  it('rejects an unknown action', async () => {
    const response = await post(CHAT_ID, MESSAGE_ID, { action: 'delete' });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      'action must be hide or unhide',
    );
  });

  it('hides a message', async () => {
    mocks.hide.mockResolvedValue(true);
    const response = await post(CHAT_ID, MESSAGE_ID, { action: 'hide' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.hide).toHaveBeenCalledWith(CHAT_ID, MESSAGE_ID);
    expect(mocks.unhide).not.toHaveBeenCalled();
  });

  it('unhides a message', async () => {
    mocks.unhide.mockResolvedValue(true);
    const response = await post(CHAT_ID, MESSAGE_ID, { action: 'unhide' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.unhide).toHaveBeenCalledWith(CHAT_ID, MESSAGE_ID);
    expect(mocks.hide).not.toHaveBeenCalled();
  });

  it('reports 404 when the command finds no such message', async () => {
    mocks.hide.mockResolvedValue(false);
    const response = await post(CHAT_ID, MESSAGE_ID, { action: 'hide' });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toBe('message not found');
  });

  it('reports 409 when the command throws (e.g. chat not owned)', async () => {
    mocks.hide.mockRejectedValue(new Error('chat not found'));
    const response = await post(CHAT_ID, MESSAGE_ID, { action: 'hide' });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe('chat not found');
  });
});
