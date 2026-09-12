import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  overview: vi.fn(),
  updateVoice: vi.fn(),
  forget: vi.fn(),
}));
vi.mock('@assistant/application/profile', () => ({
  getVoiceOverview: mocks.overview,
  organizeMemoryNow: vi.fn(),
  purgeProfileVoiceSamples: vi.fn(),
  recompileProfileCard: vi.fn(),
  updateVoiceProfile: mocks.updateVoice,
}));
vi.mock('@/lib/server', () => ({
  getApplication: () => ({ forgetLongTermMemory: mocks.forget }),
  getDb: () => ({}),
  getWorkspace: () => ({}),
}));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: mocks.auth,
  mobileJson: (body: unknown, init?: ResponseInit) => Response.json(body, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));

import { POST } from './route';

const post = (body: unknown) =>
  POST(
    new Request('https://example.com/api/mobile/v1/memory/profile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue(true);
  mocks.updateVoice.mockResolvedValue({});
});

describe('native memory profile', () => {
  it('requires authentication before mutating anything', async () => {
    mocks.auth.mockResolvedValue(false);
    expect((await post({ action: 'voice-profile' })).status).toBe(401);
    expect(mocks.updateVoice).not.toHaveBeenCalled();
  });

  /**
   * GET reports dos/donts as arrays, so a client that reads the profile, edits
   * it and posts it back sends arrays. They used to coerce to '' — the lists
   * were silently erased while description and signature saved normally.
   */
  it('keeps dos and donts that arrive as arrays, the shape GET hands out', async () => {
    await post({
      action: 'voice-profile',
      description: 'Direct.',
      dos: ['Lead with the result', 'Name the tradeoff'],
      donts: ['Hedge'],
      signature: '- B',
    });
    expect(mocks.updateVoice).toHaveBeenCalledWith(expect.anything(), {
      description: 'Direct.',
      dos: 'Lead with the result\nName the tradeoff',
      donts: 'Hedge',
      signature: '- B',
    });
  });

  it('still accepts the newline-separated strings the phone and web form send', async () => {
    await post({
      action: 'voice-profile',
      description: 'Direct.',
      dos: 'Lead with the result\nName the tradeoff',
      donts: 'Hedge',
      signature: '- B',
    });
    expect(mocks.updateVoice).toHaveBeenCalledWith(expect.anything(), {
      description: 'Direct.',
      dos: 'Lead with the result\nName the tradeoff',
      donts: 'Hedge',
      signature: '- B',
    });
  });

  it('refuses to erase memory unless the intent is spelled out a second time', async () => {
    const response = await post({ action: 'forget-all' });
    expect(response.status).toBe(400);
    expect(mocks.forget).not.toHaveBeenCalled();
  });

  it('erases memory once confirmed', async () => {
    const response = await post({ action: 'forget-all', confirm: 'forget-all' });
    expect(response.status).toBe(200);
    expect(mocks.forget).toHaveBeenCalledOnce();
  });

  it('names the actions it accepts when given one it does not', async () => {
    const response = await post({ action: 'bogus' });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain('voice-profile');
  });
});
