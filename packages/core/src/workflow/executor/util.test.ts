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
      toolCall('X'), // index 1 — dropped by the slice
      toolResult('X'), // index 2 — would be the orphaned head
    ];
    for (let i = 3; i < CONTEXT_WINDOW_LIMIT + 2; i += 1) {
      window.push(text(i % 2 === 0 ? 'user' : 'assistant', `m${i}`));
    }
    // length = LIMIT + 2, so the naive cut starts at index 2 (the orphan).
    const result = compact(window);
    expect(result[0]?.role).not.toBe('tool');
    // The orphaned tool-result was dropped, so the window is one shorter than the cap.
    expect(result.length).toBe(CONTEXT_WINDOW_LIMIT - 1);
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
