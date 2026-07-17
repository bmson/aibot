import { describe, expect, it } from 'vitest';
import { resolveAuthMode } from './auth-mode.js';

describe('resolveAuthMode', () => {
  it('fails closed when Google auth and the explicit bypass are absent', () => {
    expect(resolveAuthMode({ googleClientId: '', devBypass: false, nodeEnv: 'development' })).toBe(
      'disabled',
    );
  });

  it('allows an explicit bypass outside production', () => {
    expect(resolveAuthMode({ googleClientId: '', devBypass: true, nodeEnv: 'test' })).toBe(
      'dev-bypass',
    );
  });

  it('rejects the bypass in production', () => {
    expect(() =>
      resolveAuthMode({ googleClientId: '', devBypass: true, nodeEnv: 'production' }),
    ).toThrow('must not be enabled in production');
    expect(() =>
      resolveAuthMode({ googleClientId: 'client-id', devBypass: true, nodeEnv: 'production' }),
    ).toThrow('must not be enabled in production');
  });

  it('uses Google auth when it is configured', () => {
    expect(
      resolveAuthMode({ googleClientId: 'client-id', devBypass: false, nodeEnv: 'production' }),
    ).toBe('google');
  });
});
