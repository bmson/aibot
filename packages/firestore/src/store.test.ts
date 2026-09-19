import { describe, expect, it } from 'vitest';
import { decodeRecord, encodeRecord } from './store.js';

describe('Firestore record codec', () => {
  it('preserves integers beyond JavaScript Number precision without native int64 decoding', () => {
    const source = {
      historyId: 9223372036854775807n,
      counter: 12,
      nested: [1n, -9007199254740993n],
    };
    expect(decodeRecord(encodeRecord(source))).toEqual(source);
    expect(JSON.stringify(encodeRecord(source))).not.toContain('9223372036854776000');
  });
  it('round trips nested arrays through Firestore-compatible maps', () => {
    const source = {
      direct: [1, 2],
      nested: [[1, 2], { rows: [['a'], []] }],
    };
    const encoded = encodeRecord(source);

    expect(encoded).not.toEqual(source);
    expect(decodeRecord(encoded)).toEqual(source);
  });

  it('escapes ordinary objects that use the codec tag', () => {
    const source = {
      assistantFirestoreCodecV1: {
        kind: 'array',
        length: 1,
        items: { 0: 'ordinary application data' },
      },
    };

    expect(decodeRecord(source)).toEqual(source);
    expect(decodeRecord(encodeRecord(source))).toEqual(source);
  });

  it('continues to decode existing untagged records', () => {
    const existing = { values: ['a', 'b'], nestedMap: { enabled: true } };
    expect(decodeRecord(existing)).toEqual(existing);
  });
});
