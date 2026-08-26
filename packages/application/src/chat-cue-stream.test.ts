import { createCueScanner, stripCueTags } from '@assistant/core/chat-cues';
import { describe, expect, it } from 'vitest';
import { pumpWithCues, type StreamChunk } from './chat-cue-stream.js';

async function* chunks(deltas: string[]): AsyncIterable<StreamChunk> {
  yield { type: 'text-start', id: 't1' };
  for (const delta of deltas) yield { type: 'text-delta', id: 't1', delta };
  yield { type: 'text-end', id: 't1' };
}

async function pump(deltas: string[]) {
  const written: StreamChunk[] = [];
  const cues = await pumpWithCues(
    chunks(deltas),
    (chunk) => written.push(chunk),
    createCueScanner(),
  );
  return { written, cues };
}

describe('pumpWithCues', () => {
  it('strips a tag split across deltas and writes the cue chunk in stream order', async () => {
    const { written, cues } = await pump(['Hey [fa', 'ce: warm_smile] the', 're!']);
    expect(written).toEqual([
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'Hey ' },
      { type: 'data-face', data: { state: 'warm_smile' } },
      { type: 'text-delta', id: 't1', delta: 'the' },
      { type: 'text-delta', id: 't1', delta: 're!' },
      { type: 'text-end', id: 't1' },
    ]);
    expect(cues).toEqual([{ kind: 'face', state: 'warm_smile' }]);
  });

  it('emits cue chunks without an id so each one appends its own message part', async () => {
    const { written } = await pump(['[face: wide_excited][face: happy_squint]Yes!']);
    const dataChunks = written.filter((chunk) => chunk.type === 'data-face');
    expect(dataChunks).toHaveLength(2);
    for (const chunk of dataChunks) expect('id' in chunk).toBe(false);
  });

  it('flushes an unterminated tag as literal text before text-end', async () => {
    const { written, cues } = await pump(['done [face: cur']);
    expect(written).toEqual([
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'done ' },
      { type: 'text-delta', id: 't1', delta: '[face: cur' },
      { type: 'text-end', id: 't1' },
    ]);
    expect(cues).toEqual([]);
  });

  it('forwards non-text chunks untouched', async () => {
    async function* mixed(): AsyncIterable<StreamChunk> {
      yield { type: 'text-start', id: 't1' };
      yield { type: 'text-delta', id: 't1', delta: 'hi [theme: warm_amber]' };
      yield { type: 'reasoning-start', id: 'r1' };
      yield { type: 'text-end', id: 't1' };
    }
    const written: StreamChunk[] = [];
    await pumpWithCues(mixed(), (chunk) => written.push(chunk), createCueScanner());
    expect(written).toEqual([
      { type: 'text-start', id: 't1' },
      { type: 'data-theme', data: { name: 'warm_amber' } },
      { type: 'text-delta', id: 't1', delta: 'hi ' },
      { type: 'reasoning-start', id: 'r1' },
      { type: 'text-end', id: 't1' },
    ]);
  });

  it('writes text byte-identical to stripCueTags of the whole draft', async () => {
    const draft =
      'Hey there! [face: warm_smile] Two ways to tackle this.\n[face: thoughtful_tilt]\nPick one:\n[action_chips: "Quick & automated" | "Step-by-step guide"]';
    for (const size of [1, 3, 7, draft.length]) {
      const deltas: string[] = [];
      for (let i = 0; i < draft.length; i += size) deltas.push(draft.slice(i, i + size));
      const { written, cues } = await pump(deltas);
      const streamedText = written
        .filter((chunk) => chunk.type === 'text-delta')
        .map((chunk) => chunk.delta)
        .join('');
      const whole = stripCueTags(draft);
      expect(streamedText).toBe(whole.text);
      expect(cues).toEqual(whole.cues);
    }
  });

  it('splits the text block at a [break] and moves the rest to a fresh bubble', async () => {
    const { written, cues } = await pump(['Hello there.\n[break]\nOne ', 'more thing.']);
    expect(written).toEqual([
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'Hello there.\n' },
      { type: 'text-end', id: 't1' },
      { type: 'text-start', id: 't1:break-1' },
      { type: 'data-break', data: {} },
      { type: 'text-delta', id: 't1:break-1', delta: 'One ' },
      { type: 'text-delta', id: 't1:break-1', delta: 'more thing.' },
      // The stream's own trailing text-end closes the continuation block.
      { type: 'text-end', id: 't1:break-1' },
    ]);
    expect(cues).toEqual([{ kind: 'break', at: 13 }]);
  });

  it('stays byte-identical to stripCueTags when breaks split the draft', async () => {
    const draft =
      'Sure — two minutes.\n[break]\nFirst, the short version: it shipped.\n[break]\nWant the details?\n[action_chips: "Tell me more" | "Later"]';
    for (const size of [1, 3, 7, draft.length]) {
      const deltas: string[] = [];
      for (let i = 0; i < draft.length; i += size) deltas.push(draft.slice(i, i + size));
      const { written, cues } = await pump(deltas);
      const streamedText = written
        .filter((chunk) => chunk.type === 'text-delta')
        .map((chunk) => chunk.delta)
        .join('');
      const whole = stripCueTags(draft);
      expect(streamedText).toBe(whole.text);
      expect(cues).toEqual(whole.cues);
      // Every break produced exactly one block handoff pair.
      const ends = written.filter((chunk) => chunk.type === 'text-end');
      const starts = written.filter((chunk) => chunk.type === 'text-start');
      expect(starts).toHaveLength(3);
      expect(ends).toHaveLength(3);
    }
  });
});
