import type { Db } from '@assistant/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const stubs = vi.hoisted(() => ({ getChatUpdates: vi.fn() }));

// waitForChatUpdates is a loop around getChatUpdates; stubbing the inner read
// is what lets the holding behaviour be tested without a database.
vi.mock('./chat.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chat.js')>();
  return { ...actual, getChatUpdates: stubs.getChatUpdates };
});

const { MAX_CHAT_WAIT_MS, waitForChatUpdates } = await import('./chat-long-poll.js');

const db = {} as Db;
const CONVERSATION = { conversationId: 'c1' };
const TASK = { conversationId: 'c1', taskId: 't1' };

function updates(over: Partial<Record<string, unknown>> = {}) {
  return {
    taskStatus: 'running',
    messages: [],
    refreshed: [],
    superseded: [],
    nextCursor: null,
    hasMore: false,
    activity: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('a poll that is not asked to wait', () => {
  it('answers immediately, exactly as before', async () => {
    stubs.getChatUpdates.mockResolvedValue(updates());

    const result = await waitForChatUpdates(db, CONVERSATION);

    expect(result).toMatchObject({ taskStatus: 'running' });
    expect(stubs.getChatUpdates).toHaveBeenCalledTimes(1);
  });

  it('reports a missing conversation rather than holding the connection open', async () => {
    stubs.getChatUpdates.mockResolvedValue(null);

    await expect(waitForChatUpdates(db, { ...TASK, waitMs: 10_000 })).resolves.toBeNull();
    expect(stubs.getChatUpdates).toHaveBeenCalledTimes(1);
  });
});

describe('a held poll returns the moment there is something to say', () => {
  it('waits through quiet reads and answers on the reply', async () => {
    stubs.getChatUpdates
      .mockResolvedValueOnce(updates())
      .mockResolvedValueOnce(updates())
      .mockResolvedValueOnce(updates({ messages: [{ id: 'm1' }] }));

    const result = await waitForChatUpdates(db, { ...TASK, waitMs: MAX_CHAT_WAIT_MS });

    expect(result?.messages).toHaveLength(1);
    expect(stubs.getChatUpdates).toHaveBeenCalledTimes(3);
  });

  it('answers on a finished task even when it produced no new message', async () => {
    stubs.getChatUpdates
      .mockResolvedValueOnce(updates())
      .mockResolvedValueOnce(updates({ taskStatus: 'failed' }));

    const result = await waitForChatUpdates(db, { ...TASK, waitMs: MAX_CHAT_WAIT_MS });

    expect(result?.taskStatus).toBe('failed');
    expect(stubs.getChatUpdates).toHaveBeenCalledTimes(2);
  });

  it('answers on rows the client must remove from what it is showing', async () => {
    stubs.getChatUpdates
      .mockResolvedValueOnce(updates())
      .mockResolvedValueOnce(updates({ superseded: ['m0'] }));

    const result = await waitForChatUpdates(db, { ...TASK, waitMs: MAX_CHAT_WAIT_MS });

    expect(result?.superseded).toEqual(['m0']);
  });

  it('does not hold a backlog back — the client loops straight on for the rest', async () => {
    stubs.getChatUpdates.mockResolvedValue(updates({ hasMore: true }));

    const result = await waitForChatUpdates(db, { ...TASK, waitMs: MAX_CHAT_WAIT_MS });

    expect(result?.hasMore).toBe(true);
    expect(stubs.getChatUpdates).toHaveBeenCalledTimes(1);
  });

  it('answers when a tool moves, so the progress indicator keeps up', async () => {
    const running = { step: 1, toolName: 'gmail.search', status: 'running' };
    stubs.getChatUpdates
      .mockResolvedValueOnce(updates({ activity: [running] }))
      .mockResolvedValueOnce(updates({ activity: [running] }))
      .mockResolvedValueOnce(
        updates({ activity: [{ step: 2, toolName: 'gmail.send', status: 'running' }] }),
      );

    const result = await waitForChatUpdates(db, { ...TASK, waitMs: MAX_CHAT_WAIT_MS });

    // The tool already running on the first read is not news: the response
    // that sent this client back here already carried it.
    expect(result?.activity).toEqual([{ step: 2, toolName: 'gmail.send', status: 'running' }]);
    expect(stubs.getChatUpdates).toHaveBeenCalledTimes(3);
  });

  it('keeps holding for re-read decision cards, which every tick returns anyway', async () => {
    // refreshed is not news — treating it as news would end every hold at once
    // and quietly turn the long poll back into a fast one.
    stubs.getChatUpdates.mockResolvedValue(updates({ refreshed: [{ id: 'card-1' }] }));

    const result = await waitForChatUpdates(db, { ...TASK, waitMs: 1_200 });

    expect(result?.messages).toHaveLength(0);
    expect(stubs.getChatUpdates.mock.calls.length).toBeGreaterThan(1);
  });
});

describe('a held poll gives up politely', () => {
  it('returns the quiet answer once the budget runs out', async () => {
    stubs.getChatUpdates.mockResolvedValue(updates());

    const started = Date.now();
    const result = await waitForChatUpdates(db, { ...TASK, waitMs: 1_200 });

    expect(result).toMatchObject({ messages: [] });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
  });

  it('caps a caller that asks to be held longer than we are willing to hold', async () => {
    stubs.getChatUpdates.mockResolvedValue(updates());
    const started = Date.now();

    // Far beyond the cap; if it were honoured this test would time out rather
    // than return, which is the failure this pins.
    await waitForChatUpdates(db, {
      ...TASK,
      waitMs: 10 * 60 * 1_000,
      signal: AbortSignal.timeout(1_500),
    });

    expect(Date.now() - started).toBeLessThan(MAX_CHAT_WAIT_MS);
  });

  it('stops as soon as the caller hangs up', async () => {
    stubs.getChatUpdates.mockResolvedValue(updates());
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 700);

    const started = Date.now();
    await waitForChatUpdates(db, {
      ...TASK,
      waitMs: MAX_CHAT_WAIT_MS,
      signal: controller.signal,
    });

    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('never holds an already-aborted request', async () => {
    stubs.getChatUpdates.mockResolvedValue(updates());

    const result = await waitForChatUpdates(db, {
      ...TASK,
      waitMs: MAX_CHAT_WAIT_MS,
      signal: AbortSignal.abort(),
    });

    expect(result).toMatchObject({ messages: [] });
    expect(stubs.getChatUpdates).toHaveBeenCalledTimes(1);
  });
});
