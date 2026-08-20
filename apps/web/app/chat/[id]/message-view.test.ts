import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  dayLabel,
  orderChatLog,
  retireProvisionalReplies,
  retireProvisionalUserTurns,
  sameDay,
  timeLabel,
} from './message-view';

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

function order(messages: UIMessage[]): string[] {
  return orderChatLog(messages, new Map()).map((message) => message.id);
}

describe('orderChatLog', () => {
  it('orders a late arrival from an earlier task before a turn already on screen', () => {
    expect(
      order([
        durable('b', 'user', 'second', '2026-08-18T10:05:00.000Z'),
        durable('a', 'assistant', 'first', '2026-08-18T10:00:00.000Z'),
      ]),
    ).toEqual(['a', 'b']);
  });

  it('keeps an in-flight local turn at the end, where it is being typed', () => {
    expect(
      order([
        provisional('local', 'user', 'typing'),
        durable('a', 'assistant', 'first', '2026-08-18T10:00:00.000Z'),
      ]),
    ).toEqual(['a', 'local']);
  });

  it('breaks a timestamp tie on id so the order is stable across polls', () => {
    const at = '2026-08-18T10:00:00.000Z';
    expect(order([durable('b', 'user', 'x', at), durable('a', 'user', 'y', at)])).toEqual([
      'a',
      'b',
    ]);
    expect(order([durable('a', 'user', 'y', at), durable('b', 'user', 'x', at)])).toEqual([
      'a',
      'b',
    ]);
  });

  it('never floats a streaming reply above the question that prompted it', () => {
    // Both are undated, and the AI SDK's ids are random — sorting them by id
    // put the answer above the question roughly half the time. Arrival order
    // is the only thing that knows which came first.
    const arrival = new Map<string, number>();
    const question = provisional('zzz-user', 'user', 'what is on today?');
    const reply = provisional('aaa-assistant', 'assistant', 'Two meetings…');
    const log = orderChatLog([question, reply], arrival);
    expect(log.map((message) => message.id)).toEqual(['zzz-user', 'aaa-assistant']);
    // And it stays put once a durable message from earlier is merged in.
    const withEarlier = orderChatLog(
      [reply, durable('s1', 'assistant', 'earlier', '2026-08-18T09:00:00.000Z'), question],
      arrival,
    );
    expect(withEarlier.map((message) => message.id)).toEqual(['s1', 'zzz-user', 'aaa-assistant']);
  });
});

describe('retireProvisionalUserTurns', () => {
  it('retires the optimistic turn when its persisted twin is in the log', () => {
    const log = [
      durable('s1', 'assistant', 'earlier', '2026-08-18T09:00:00.000Z'),
      provisional('local-user', 'user', 'book the flight'),
      durable('s2', 'user', 'book the flight', '2026-08-18T10:00:00.000Z'),
    ];
    const kept = retireProvisionalUserTurns(log, new Set(['s1', 's2']));
    expect(kept.map((message) => message.id)).toEqual(['s1', 's2']);
  });

  it('shows the same question twice when it was genuinely asked twice', () => {
    // One durable copy must retire exactly one local copy, not both.
    const log = [
      provisional('local-1', 'user', 'status?'),
      provisional('local-2', 'user', 'status?'),
      durable('s2', 'user', 'status?', '2026-08-18T10:00:00.000Z'),
    ];
    const kept = retireProvisionalUserTurns(log, new Set(['s2']));
    expect(kept.map((message) => message.id)).toEqual(['local-2', 's2']);
  });
});

describe('retireProvisionalReplies', () => {
  it('retires the streamed reply once its persisted twin is in the log', () => {
    const log = [
      provisional('streamed', 'assistant', 'Booked it.'),
      durable('s2', 'assistant', 'Booked it.', '2026-08-18T10:00:00.000Z'),
    ];
    const kept = retireProvisionalReplies(log, new Set(['s2']));
    expect(kept.map((message) => message.id)).toEqual(['s2']);
  });

  it('does not let an unrelated durable message delete a reply', () => {
    // A scheduled brief, a watch firing, or inbound mail mirrored into chat all
    // arrive as durable assistant messages. None of them is the twin of the
    // reply being streamed, and the old rule deleted it for every one of them.
    const log = [
      provisional('streamed', 'assistant', 'Two meetings, both after lunch.'),
      durable('s2', 'assistant', 'Your 3pm moved to 4pm.', '2026-08-18T10:00:00.000Z'),
    ];
    const kept = retireProvisionalReplies(log, new Set(['s2']));
    expect(kept.map((message) => message.id)).toEqual(['streamed', 's2']);
  });

  it('reconciles against the whole log, not just the newest page', () => {
    // The twin arrived on a tick that ran mid-stream, when replies are left
    // alone. Nothing new comes in afterwards, so matching only against a poll's
    // own page would leave the duplicate on screen forever.
    const log = [
      durable('s2', 'assistant', 'Booked it.', '2026-08-18T10:00:00.000Z'),
      provisional('streamed', 'assistant', 'Booked it.'),
    ];
    expect(retireProvisionalReplies(log, new Set(['s2'])).map((m) => m.id)).toEqual(['s2']);
  });

  it('never drops a message the server has already vouched for', () => {
    const log = [durable('s1', 'assistant', 'kept', '2026-08-18T09:00:00.000Z')];
    expect(retireProvisionalReplies(log, new Set(['s1'])).map((m) => m.id)).toEqual(['s1']);
  });
});

describe('date labels', () => {
  // Formatting in the agent's zone is what lets the server render the dividers
  // into the first paint: the browser must reach the same strings whatever its
  // own zone is, or React would report a hydration mismatch.
  const at = new Date('2026-08-18T02:30:00.000Z');
  const now = new Date('2026-08-19T12:00:00.000Z');

  it('answers from the zone it is given, never from the machine clock', () => {
    // Same instant, two zones, two different calendar days — which is exactly
    // why the zone has to be an argument rather than ambient: the server and
    // the browser must be able to reach the same string on purpose.
    expect(dayLabel(at, now, 'America/Los_Angeles')).toBe('Aug 17');
    expect(timeLabel(at, 'America/Los_Angeles')).toBe('7:30 PM');
    expect(dayLabel(at, now, 'Atlantic/Reykjavik')).toBe('Yesterday');
    expect(timeLabel(at, 'Atlantic/Reykjavik')).toBe('2:30 AM');
  });

  it('reads the calendar day in the given zone, not UTC', () => {
    // 02:30Z on the 18th is still the evening of the 17th in Los Angeles.
    const alsoThe17th = new Date('2026-08-18T04:00:00.000Z');
    expect(sameDay(at, alsoThe17th, 'America/Los_Angeles')).toBe(true);
    expect(sameDay(at, alsoThe17th, 'Atlantic/Reykjavik')).toBe(true);
    const the18thInReykjavik = new Date('2026-08-18T09:00:00.000Z');
    expect(sameDay(at, the18thInReykjavik, 'Atlantic/Reykjavik')).toBe(true);
    expect(sameDay(at, the18thInReykjavik, 'America/Los_Angeles')).toBe(false);
  });

  it('names an older day, adding the year only when it is not this one', () => {
    expect(dayLabel(new Date('2026-03-04T12:00:00.000Z'), now, 'Atlantic/Reykjavik')).toBe('Mar 4');
    expect(dayLabel(new Date('2025-03-04T12:00:00.000Z'), now, 'Atlantic/Reykjavik')).toBe(
      'Mar 4, 2025',
    );
  });
});
