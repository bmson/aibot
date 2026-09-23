import { describe, expect, it } from 'vitest';
import { assertEstimatedCostWithinLimit } from './router.js';

describe('per-call estimated model cost limit', () => {
  it('allows a call at or below its explicit estimate ceiling', () => {
    expect(() => assertEstimatedCostWithinLimit(0.005, 0.005)).not.toThrow();
    expect(() => assertEstimatedCostWithinLimit(0.004, 0.005)).not.toThrow();
    expect(() => assertEstimatedCostWithinLimit(0.004, undefined)).not.toThrow();
  });

  it('rejects invalid limits and estimates above the ceiling before reservation', () => {
    expect(() => assertEstimatedCostWithinLimit(0.0051, 0.005)).toThrow(
      'estimated model call cost exceeds caller limit',
    );
    expect(() => assertEstimatedCostWithinLimit(0.001, 0)).toThrow(
      'estimated model call cost exceeds caller limit',
    );
    expect(() => assertEstimatedCostWithinLimit(0.001, Number.NaN)).toThrow(
      'estimated model call cost exceeds caller limit',
    );
  });
});
