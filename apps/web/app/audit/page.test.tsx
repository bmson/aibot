import { randomUUID } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ owner: vi.fn(), list: vi.fn(), detail: vi.fn() }));
vi.mock('@/auth', () => ({ requireOwner: state.owner }));
vi.mock('@/lib/task-activity', () => ({
  listTaskActivity: state.list,
  getTaskActivityDetail: state.detail,
}));

vi.mock('@/lib/audit-investigation', () => ({ getAuditInvestigation: state.detail }));

import AuditDetailPage from './[id]/page';
import AuditPage from './page';

beforeEach(() => {
  vi.resetAllMocks();
  state.owner.mockResolvedValue({});
});
describe('owner audit console', () => {
  it('searches a bounded view and links to audit records', async () => {
    const id = randomUUID();
    state.list.mockResolvedValue({
      items: [
        {
          id,
          title: 'Email failure',
          type: 'chat',
          status: 'failed',
          progress: 'Provider timed out',
          updatedAt: new Date(),
          spentUsd: '0.03',
        },
      ],
      archivedCount: 0,
    });
    const html = renderToStaticMarkup(
      await AuditPage({
        searchParams: Promise.resolve({ q: id, view: 'archived', filter: 'completed' }),
      }),
    );
    expect(state.list).toHaveBeenCalledWith({ archived: true, filter: 'completed', limit: 100 });
    expect(html).toContain(`/audit/${id}`);
    expect(html).toContain('Provider timed out');
    expect(html).not.toContain('/chat');
  });
  it('requires owner authentication before reading any records', async () => {
    state.owner.mockRejectedValue(new Error('sign in required'));
    await expect(AuditPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      'sign in required',
    );
    await expect(
      AuditDetailPage({
        params: Promise.resolve({ id: randomUUID() }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow('sign in required');
    expect(state.list).not.toHaveBeenCalled();
    expect(state.detail).not.toHaveBeenCalled();
  });
  it('shows failure context, investigation request, and section-specific pagination', async () => {
    const id = randomUUID();
    state.detail.mockResolvedValue({
      task: {
        title: 'Failed send',
        status: 'failed',
        progress: 'Check provider',
        attempt: 2,
        spentUsd: '0.03',
      },
      investigationPrompt: `Investigate audit record ${id}`,
      evidenceNotes: ['Missing capture is not proof of no call.'],
      sections: [
        {
          name: 'toolCalls',
          entries: [
            {
              id: randomUUID(),
              at: '2026-09-30T01:00:00Z',
              fields: {
                toolName: { text: 'gmail.send', hasMore: false },
                error: { text: 'Provider unavailable', hasMore: false },
              },
            },
          ],
          nextCursor: 'stable-cursor',
        },
      ],
    });
    const html = renderToStaticMarkup(
      await AuditDetailPage({
        params: Promise.resolve({ id }),
        searchParams: Promise.resolve({ section: 'toolCalls' }),
      }),
    );
    expect(html).toContain('Provider unavailable');
    expect(html).toContain('Investigate with the bot');
    expect(html).toContain('Attempt 2');
    expect(html).toContain('cursor=stable-cursor');
    expect(html).toContain('Download records');
    expect(html).not.toContain('Retry task');
  });
});
