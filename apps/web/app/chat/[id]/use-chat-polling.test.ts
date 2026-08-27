import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { mergeChatLog } from './use-chat-polling';

const NOT_STREAMING = { streaming: false, retracted: new Set<string>() };

/** A message as the server sends it: real id, persisted timestamp. */
function durable(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  at = '2026-08-18T10:00:00.000Z',
): UIMessage {
  return { id, role, parts: [{ type: 'text', text }], metadata: { createdAt: at } } as UIMessage;
}

/** An unanswered approval card — the thing `refresh` re-reads on every tick. */
function card(id: string, status: string): UIMessage {
  return {
    id,
    role: 'assistant',
    parts: [{ type: 'approval', approvalId: 'a1', status }],
    metadata: { createdAt: '2026-08-18T10:00:00.000Z' },
  } as unknown as UIMessage;
}

describe('mergeChatLog', () => {
  it('adds rows the log has not seen', () => {
    const current = [durable('a', 'user', 'hello')];
    const merged = mergeChatLog(current, [durable('b', 'assistant', 'hi')], {
      ...NOT_STREAMING,
      serverIds: new Set(['a', 'b']),
    });
    expect(merged.map((message) => message.id)).toEqual(['a', 'b']);
  });

  it('replaces a row whose content actually changed', () => {
    const current = [card('c1', 'pending')];
    const merged = mergeChatLog(current, [card('c1', 'approved')], {
      ...NOT_STREAMING,
      serverIds: new Set(['c1']),
    });
    expect(merged).not.toBe(current);
    const parts = merged[0]?.parts as Array<{ status?: string }> | undefined;
    expect(parts?.[0]?.status).toBe('approved');
  });

  // The finding this function exists for: `refresh` re-reads every open
  // decision card on EVERY tick, so an idle thread with one unanswered
  // approval was handing React a new array every twelve seconds.
  it('hands back the same array when a re-read changed nothing', () => {
    const current = [durable('a', 'user', 'hello'), card('c1', 'pending')];
    const merged = mergeChatLog(current, [card('c1', 'pending')], {
      ...NOT_STREAMING,
      serverIds: new Set(['a', 'c1']),
    });
    expect(merged).toBe(current);
  });

  it('still retires a provisional turn on a tick that brought nothing new', () => {
    const provisional = {
      id: 'local',
      role: 'user',
      parts: [{ type: 'text', text: 'go' }],
    } as UIMessage;
    const current = [durable('s1', 'user', 'go'), provisional];
    const merged = mergeChatLog(current, [], {
      ...NOT_STREAMING,
      serverIds: new Set(['s1']),
    });
    expect(merged.map((message) => message.id)).toEqual(['s1']);
  });

  it('removes a row the server superseded', () => {
    const current = [
      durable('old', 'assistant', 'stopped'),
      durable('new', 'assistant', 'stopped'),
    ];
    const merged = mergeChatLog(current, [], {
      streaming: false,
      serverIds: new Set(['old', 'new']),
      retracted: new Set(['old']),
    });
    expect(merged.map((message) => message.id)).toEqual(['new']);
  });

  it('leaves a streaming reply alone until it finishes', () => {
    const streamed = {
      id: 'stream-1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'partial' }],
    } as UIMessage;
    const current = [streamed];
    const merged = mergeChatLog(current, [durable('s1', 'assistant', 'partial')], {
      streaming: true,
      serverIds: new Set(['s1']),
      retracted: new Set<string>(),
    });
    expect(merged.map((message) => message.id)).toEqual(['stream-1', 's1']);
  });
});
