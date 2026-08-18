import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { bySendTime, dropProvisional } from './message-view';

/** A message as the server sends it: real id, persisted timestamp. */
function durable(id: string, role: 'user' | 'assistant', text: string, at?: string): UIMessage {
  return {
    id,
    role,
    parts: [{ type: 'text', text }],
    ...(at ? { metadata: { createdAt: at } } : {}),
  } as UIMessage;
}

/** A message the client made itself: local id, no persisted timestamp. */
function provisional(id: string, role: 'user' | 'assistant', text: string): UIMessage {
  return { id, role, parts: [{ type: 'text', text }] } as UIMessage;
}

describe('bySendTime', () => {
  it('orders a late arrival from an earlier task before a turn already on screen', () => {
    const sorted = [
      durable('b', 'user', 'second', '2026-08-18T10:05:00.000Z'),
      durable('a', 'assistant', 'first', '2026-08-18T10:00:00.000Z'),
    ].sort(bySendTime);
    expect(sorted.map((message) => message.id)).toEqual(['a', 'b']);
  });

  it('keeps an in-flight local turn at the end, where it is being typed', () => {
    const sorted = [
      provisional('local', 'user', 'typing'),
      durable('a', 'assistant', 'first', '2026-08-18T10:00:00.000Z'),
    ].sort(bySendTime);
    expect(sorted.map((message) => message.id)).toEqual(['a', 'local']);
  });

  it('breaks a timestamp tie on id so the order is stable across polls', () => {
    const at = '2026-08-18T10:00:00.000Z';
    const first = [durable('b', 'user', 'x', at), durable('a', 'user', 'y', at)].sort(bySendTime);
    const again = [durable('a', 'user', 'y', at), durable('b', 'user', 'x', at)].sort(bySendTime);
    expect(first.map((m) => m.id)).toEqual(['a', 'b']);
    expect(again.map((m) => m.id)).toEqual(['a', 'b']);
  });
});

describe('dropProvisional', () => {
  const serverIds = new Set(['s1']);

  it('retires the optimistic user turn when its persisted twin arrives', () => {
    const incoming = [durable('s2', 'user', 'book the flight', '2026-08-18T10:00:00.000Z')];
    const merged = [
      durable('s1', 'assistant', 'earlier', '2026-08-18T09:00:00.000Z'),
      provisional('local-user', 'user', 'book the flight'),
      ...incoming,
    ];
    const kept = dropProvisional(merged, incoming, new Set([...serverIds, 's2']));
    expect(kept.map((message) => message.id)).toEqual(['s1', 's2']);
  });

  it('shows the same question twice when it was genuinely asked twice', () => {
    // One incoming match must retire exactly one local copy, not both.
    const incoming = [durable('s2', 'user', 'status?', '2026-08-18T10:00:00.000Z')];
    const merged = [
      provisional('local-1', 'user', 'status?'),
      provisional('local-2', 'user', 'status?'),
      ...incoming,
    ];
    const kept = dropProvisional(merged, incoming, new Set(['s2']));
    expect(kept.map((message) => message.id)).toEqual(['local-2', 's2']);
  });

  it('retires the streamed reply and the async acknowledgement once a durable reply lands', () => {
    const incoming = [durable('s2', 'assistant', 'Booked it.', '2026-08-18T10:00:00.000Z')];
    const merged = [
      provisional('ack', 'assistant', 'Got it — I’m working on this now.'),
      provisional('streamed', 'assistant', 'Booked it.'),
      ...incoming,
    ];
    const kept = dropProvisional(merged, incoming, new Set(['s2']));
    expect(kept.map((message) => message.id)).toEqual(['s2']);
  });

  it('keeps a local reply while the server has sent none, so nothing blanks mid-turn', () => {
    const incoming = [durable('s2', 'user', 'hello', '2026-08-18T10:00:00.000Z')];
    const merged = [provisional('streamed', 'assistant', 'partial…'), ...incoming];
    const kept = dropProvisional(merged, incoming, new Set(['s2']));
    expect(kept.map((message) => message.id)).toEqual(['streamed', 's2']);
  });

  it('never drops a message the server has already vouched for', () => {
    const merged = [durable('s1', 'assistant', 'kept', '2026-08-18T09:00:00.000Z')];
    const kept = dropProvisional(merged, [], serverIds);
    expect(kept.map((message) => message.id)).toEqual(['s1']);
  });
});
