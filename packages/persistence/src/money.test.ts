import { describe, expect, it } from 'vitest';
import { addMicros, microsToUsd, usdToMicros } from './money.js';

describe('ledger precision', () => {
  it('avoids floating point accumulation in budget decisions', () => {
    expect(microsToUsd(addMicros(usdToMicros(0.1), usdToMicros(0.2)))).toBe(0.3);
    expect(usdToMicros(0.000001)).toBe(1);
  });
  it('rejects invalid amounts and overflow rather than weakening the cap', () => {
    for (const value of [NaN, Infinity, -1, Number.MAX_VALUE])
      expect(() => usdToMicros(value)).toThrow();
    expect(() => addMicros(Number.MAX_SAFE_INTEGER, 1)).toThrow();
  });
});
