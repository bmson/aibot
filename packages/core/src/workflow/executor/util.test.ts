import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { CONTEXT_TOKEN_BUDGET, CONTEXT_WINDOW_LIMIT, compact } from './util.js';

const toolCall = (id: string): ModelMessage =>
  ({
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId: id, toolName: 't', input: {} }],
  }) as ModelMessage;
const toolResult = (id: string): ModelMessage =>
  ({
    role: 'tool',
    content: [
      { type: 'tool-result', toolCallId: id, toolName: 't', output: { type: 'json', value: {} } },
    ],
  }) as ModelMessage;
const text = (role: 'user' | 'assistant', s: string): ModelMessage =>
  ({ role, content: s }) as ModelMessage;

describe('compact', () => {
  it('returns the window unchanged when within the limit', () => {
    const w = [text('user', 'a'), text('assistant', 'b')];
    expect(compact(w)).toBe(w);
  });

  it('never begins the compacted window on an orphaned tool-result', () => {
    // Cut lands (length-LIMIT) exactly on a tool-result whose tool-call is dropped.
    const window: ModelMessage[] = [
      text('user', 'q'),
      toolCall('X'), // dropped by the slice
      toolResult('X'), // would be the orphaned head
    ];
    for (let i = 3; i < CONTEXT_WINDOW_LIMIT + 2; i += 1) {
      window.push(text(i % 2 === 0 ? 'user' : 'assistant', `m${i}`));
    }
    const result = compact(window);
    // Neither the pinned instruction nor the tail starts on an orphaned result.
    expect(result[0]?.role).not.toBe('tool');
    expect(result.some((m) => m.role === 'tool')).toBe(false);
    // The bound still holds: pinned instruction (1) + a tail of LIMIT-1.
    expect(result.length).toBe(CONTEXT_WINDOW_LIMIT);
  });

  it('pins the first user message (the instruction) even when it would age out', () => {
    const window: ModelMessage[] = [text('user', 'ORIGINAL INSTRUCTION')];
    for (let i = 0; i < CONTEXT_WINDOW_LIMIT + 20; i += 1) {
      window.push(text(i % 2 === 0 ? 'assistant' : 'user', `later ${i}`));
    }
    const result = compact(window);
    // The instruction survives at the head despite being far past the cut.
    expect(result[0]).toEqual(text('user', 'ORIGINAL INSTRUCTION'));
    expect(result.length).toBe(CONTEXT_WINDOW_LIMIT);
    // And the most recent message is still retained (drop-oldest, not newest).
    expect(result.at(-1)).toEqual(window.at(-1));
  });

  it('does not duplicate the instruction when it already survives in the tail', () => {
    const window: ModelMessage[] = [text('user', 'instr')];
    for (let i = 0; i < 5; i += 1) window.push(text('assistant', `m${i}`));
    // Within the limit → returned unchanged (single copy of the instruction).
    const result = compact(window);
    expect(result.filter((m) => m.content === 'instr')).toHaveLength(1);
  });

  it('keeps a retained assistant tool-call and its following result together', () => {
    const window: ModelMessage[] = [];
    for (let i = 0; i < CONTEXT_WINDOW_LIMIT; i += 1) window.push(text('user', `pad${i}`));
    // A paired exchange at the tail is always retained intact.
    window.push(toolCall('Y'), toolResult('Y'));
    const result = compact(window);
    const call = result.find(
      (m) =>
        m.role === 'assistant' && Array.isArray(m.content) && m.content[0]?.type === 'tool-call',
    );
    const res = result.find((m) => m.role === 'tool');
    expect(call).toBeDefined();
    expect(res).toBeDefined();
  });
});

describe('compact token budget', () => {
  it('trims well below the message-count bound when messages are large', () => {
    // 40 messages × ~10 KB each ≈ 400 KB — far over the ~87 KB char budget
    // while comfortably under the 60-message bound.
    const window: ModelMessage[] = [text('user', 'instruction')];
    for (let i = 0; i < 40; i += 1) window.push(text('assistant', 'x'.repeat(10_000)));
    const result = compact(window);

    expect(result.length).toBeLessThan(window.length);
    const chars = result.reduce((sum, m) => sum + JSON.stringify(m).length, 0);
    expect(chars).toBeLessThanOrEqual(CONTEXT_TOKEN_BUDGET * 3.5 + 10_100);
    // The instruction is pinned and the newest message survives.
    expect(result[0]).toEqual(text('user', 'instruction'));
    expect(result.at(-1)).toEqual(window.at(-1));
  });

  it('always keeps the newest message even when it alone busts the budget', () => {
    const window: ModelMessage[] = [
      text('user', 'instruction'),
      text('assistant', 'a'),
      text('user', 'y'.repeat(200_000)),
    ];
    const result = compact(window);
    expect(result.at(-1)).toEqual(window.at(-1));
  });

  it('keeps the tool result when the assistant tool-call args alone bust the budget', () => {
    // The reproduced data-loss case: a large artifact body in docs.create args
    // used to collapse the window to just the instruction, discarding the tool
    // result (the created document's URL) the model had just obtained.
    const bigCall: ModelMessage = {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'D',
          toolName: 'docs.create',
          input: { body: 'z'.repeat(200_000) },
        },
      ],
    } as ModelMessage;
    const result: ModelMessage = {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'D',
          toolName: 'docs.create',
          output: { type: 'json', value: { url: 'https://docs.example/d/abc123' } },
        },
      ],
    } as ModelMessage;
    const window: ModelMessage[] = [text('user', 'write me a doc'), bigCall, result];

    const compacted = compact(window);

    // The tool result (with the URL) survives, paired with its tool-call.
    const toolResultMsg = compacted.find((m) => m.role === 'tool');
    expect(JSON.stringify(toolResultMsg)).toContain('abc123');
    const callMsg = compacted.find(
      (m) =>
        m.role === 'assistant' && Array.isArray(m.content) && m.content[0]?.type === 'tool-call',
    );
    expect(callMsg).toBeDefined();
    // The instruction is still pinned, and the oversized args are elided.
    expect(compacted[0]).toEqual(text('user', 'write me a doc'));
    expect(JSON.stringify(compacted)).not.toContain('z'.repeat(200_000));
    expect(JSON.stringify(callMsg)).toContain('elided');
  });
});
