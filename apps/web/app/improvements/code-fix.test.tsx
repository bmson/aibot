import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { POST } from '../api/mobile/v1/improvements/[id]/route';
import { requestCodeFixAction } from './code-fix-action';
import { ProposalCard } from './proposal-card';

const state = vi.hoisted(() => ({ list: vi.fn(), report: vi.fn(), authed: vi.fn() }));
vi.mock('@/auth', () => ({ requireOwner: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/server', () => ({
  getApplication: () => ({ listImprovementProposals: state.list }),
  getSelfRepairService: async () => ({ agentId: 'owner', repository: { report: state.report } }),
}));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: state.authed,
  mobileJson: Response.json,
  mobileUnauthorized: () => new Response(null, { status: 401 }),
}));

it('requests code fixes', async () => {
  const id = '12345678-1234-4234-8234-123456789abc';
  const proposal = {
    id,
    kind: 'note',
    title: 'Fix',
    rationale: 'Why',
    suggestion: 'Retry',
    evidenceCount: 0,
    applyable: false,
    createdLabel: '',
  };
  const html = renderToStaticMarkup(<ProposalCard proposal={proposal} />);
  expect(html).toContain('Request code fix');
  expect(html).toContain('Acknowledge');
  expect(html).toContain('Dismiss');
  state.authed.mockResolvedValue(true);
  state.list.mockResolvedValue([{ ...proposal, change: { suggestion: proposal.suggestion } }]);
  state.report.mockResolvedValue({ id: 'issue' });
  const request = () =>
    POST(
      new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({ action: 'request_code_fix' }),
      }),
      { params: Promise.resolve({ id }) },
    );
  expect((await request()).status).toBe(200);
  await requestCodeFixAction(id);
  const [owner, report] = state.report.mock.calls[0] ?? [];
  expect(owner).toBe('owner');
  expect(report).toMatchObject({ source: 'proposal', proposalId: id, title: proposal.title });
  expect(report.summary).toContain(proposal.suggestion);
  expect(report).not.toHaveProperty('manualRunRequestedAt');
  expect(state.report.mock.calls[1]).toEqual([owner, report]);
  state.list.mockResolvedValue([]);
  expect((await request()).status).toBe(409);
  expect(state.report).toHaveBeenCalledTimes(2);
  state.authed.mockResolvedValue(false);
  expect((await request()).status).toBe(401);
});
