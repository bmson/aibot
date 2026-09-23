import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  identity: vi.fn(),
  presence: vi.fn(),
}));

vi.mock('@/auth', () => ({ isAuthed: mocks.auth }));
vi.mock('@/lib/server', () => ({ getAgentIdentity: mocks.identity }));
vi.mock('@/lib/shell-presence', () => ({ getWebShellPresence: mocks.presence }));
vi.mock('@assistant/config', () => ({
  loadConfig: () => ({ PERSISTENCE_DRIVER: 'firestore' }),
}));

import { proxy } from '../../../../proxy';
import { GET } from './route';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { email: 'owner@example.com' } });
  mocks.identity.mockResolvedValue({ id: 'agent-1', name: 'Assistant', avatarUrl: null });
  mocks.presence.mockResolvedValue('attention');
});

describe('shell presence route', () => {
  it('requires web authentication before reading presence', async () => {
    mocks.auth.mockResolvedValue(null);
    const response = await GET();
    expect(response.status).toBe(401);
    expect(mocks.presence).not.toHaveBeenCalled();
  });

  it('returns only the narrow presence contract without caching the response', async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ presence: 'attention' });
    expect(mocks.presence).toHaveBeenCalledWith('agent-1');
  });

  it('allows only GET shell presence through the Firestore web proxy', () => {
    expect(proxy(new NextRequest('http://localhost/api/shell/status')).status).toBe(200);
    expect(
      proxy(new NextRequest('http://localhost/api/shell/status', { method: 'POST' })).status,
    ).toBe(503);
  });
});
