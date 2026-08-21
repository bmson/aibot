import { describe, expect, it } from 'vitest';
import { secureTokenMatches } from './mobile-token';

describe('mobile bearer authentication', () => {
  it('accepts only the complete configured token', () => {
    const token = 'd8d42649c69262c8d50f937066c66bc64c12e12d8ff0c2e2b16ef8ea275891ef';
    expect(secureTokenMatches(token, token)).toBe(true);
    expect(secureTokenMatches(token, `${token}0`)).toBe(false);
    expect(secureTokenMatches(token, token.slice(0, -1))).toBe(false);
  });

  it('never treats an empty token as a credential', () => {
    expect(secureTokenMatches('', '')).toBe(false);
    expect(secureTokenMatches('configured', '')).toBe(false);
  });
});
