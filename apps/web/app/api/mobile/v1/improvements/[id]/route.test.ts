import { beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ auth: vi.fn(), requestFix: vi.fn(), decide: vi.fn() }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: mock.auth,
  mobileJson: (body: unknown, init?: ResponseInit) => Response.json(body, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/proposal-code-fix', () => ({ requestOwnerProposalCodeFix: mock.requestFix }));
vi.mock('@/lib/workspace-reviews', () => ({ decideOwnerImprovement: mock.decide }));

import { POST } from './route';

const id = '00000000-0000-4000-a000-000000000001';
const request = (action: string) =>
  POST(
    new Request(`http://localhost/api/mobile/v1/improvements/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    }),
    { params: Promise.resolve({ id }) },
  );
beforeEach(() => {
  vi.clearAllMocks();
  mock.auth.mockResolvedValue(true);
  mock.requestFix.mockResolvedValue({ id: 'repair' });
});
it('requires owner mobile authentication before conversion', async () => {
  mock.auth.mockResolvedValue(false);
  expect((await request('request_fix')).status).toBe(401);
  expect(mock.requestFix).not.toHaveBeenCalled();
});
it('routes conversion through the shared owned-proposal service and returns the report ID', async () => {
  const response = await request('request_fix');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, repairIssueId: 'repair' });
  expect(mock.requestFix).toHaveBeenCalledWith(id);
  expect(mock.decide).not.toHaveBeenCalled();
});
it('rejects unknown actions and reports conversion conflicts', async () => {
  expect((await request('unknown')).status).toBe(400);
  mock.requestFix.mockRejectedValueOnce(new Error('Open proposal not found'));
  expect((await request('request_fix')).status).toBe(409);
});
