import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { CONTEXT_WINDOW_LIMIT, compact } from './util.js';

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
