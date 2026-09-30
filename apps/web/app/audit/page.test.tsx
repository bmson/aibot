import { randomUUID } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ owner: vi.fn(), list: vi.fn(), detail: vi.fn() }));
vi.mock('@/auth', () => ({ requireOwner: state.owner }));
vi.mock('@/lib/task-activity', () => ({
  listTaskActivity: state.list,
  getTaskActivityDetail: state.detail,
}));

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
  it('shows recorded errors and a cursor for older entries without action controls', async () => {
    const id = randomUUID();
    const at = new Date('2026-09-29T12:00:00Z');
    state.detail.mockResolvedValue({
      timezone: 'UTC',
      task: { title: 'Failed send', status: 'failed', progress: 'Check provider' },
      toolCalls: [
        {
          id: 'tool',
          createdAt: at,
          toolName: 'gmail.send',
          status: 'failed',
          args: null,
          result: null,
          error: { text: 'Provider unavailable', totalChars: 20, truncated: false },
        },
      ],
      modelCalls: [],
      approvals: [],
      messages: [],
      hasMoreTimeline: true,
    });
    const html = renderToStaticMarkup(
      await AuditDetailPage({
        params: Promise.resolve({ id }),
        searchParams: Promise.resolve({ before: 'invalid' }),
      }),
    );
    expect(state.detail).toHaveBeenCalledWith(id, {});
    expect(html).toContain('Provider unavailable');
    expect(html).toContain('Older entries');
    expect(html).toContain(encodeURIComponent(at.toISOString()));
    expect(html).not.toContain('<form');
  });
});
