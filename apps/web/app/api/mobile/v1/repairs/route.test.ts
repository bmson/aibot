import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  allowed: vi.fn(),
  overview: vi.fn(),
  report: vi.fn(),
  decide: vi.fn(),
}));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: mocks.allowed,
  mobileJson: (value: unknown, init?: ResponseInit) => Response.json(value, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/self-repair-server', () => ({
  getSelfRepairOverview: mocks.overview,
  reportOwnerRepair: mocks.report,
  decideOwnerRepair: mocks.decide,
}));

import { POST as decide } from './[id]/route';
import { GET, POST } from './route';

const request = (body: unknown) =>
  new Request('https://assistant.invalid/api/mobile/v1/repairs', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.allowed.mockResolvedValue(true);
});
describe('owner repair endpoints', () => {
  it('refuses unauthenticated reads, reports and decisions before accessing storage', async () => {
    mocks.allowed.mockResolvedValue(false);
    expect((await GET(request({}))).status).toBe(401);
    expect((await POST(request({}))).status).toBe(401);
    expect(
      (await decide(request({}), { params: Promise.resolve({ id: randomUUID() }) })).status,
    ).toBe(401);
    expect(mocks.overview).not.toHaveBeenCalled();
    expect(mocks.report).not.toHaveBeenCalled();
    expect(mocks.decide).not.toHaveBeenCalled();
  });
  it('validates reports and decisions rather than accepting arbitrary states or task IDs', async () => {
    expect(
      (await POST(request({ title: 'Problem', summary: 'A failure', sourceTaskId: 'foreign' })))
        .status,
    ).toBe(400);
    expect(
      (
        await decide(request({ action: 'merged' }), {
          params: Promise.resolve({ id: randomUUID() }),
        })
      ).status,
    ).toBe(400);
    expect(mocks.report).not.toHaveBeenCalled();
    expect(mocks.decide).not.toHaveBeenCalled();
  });
  it('records a validated report and surfaces conflicting owner actions', async () => {
    const id = randomUUID();
    mocks.report.mockResolvedValue({ id });
    expect(
      await (await POST(request({ title: 'Problem', summary: 'A reproducible failure' }))).json(),
    ).toEqual({ ok: true, issueId: id });
    mocks.decide.mockRejectedValue(new Error('Only failed or blocked issues can be retried'));
    expect(
      (await decide(request({ action: 'retry' }), { params: Promise.resolve({ id }) })).status,
    ).toBe(409);
  });
});
