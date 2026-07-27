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

  it('allows a production-built image only in an explicit local installation', () => {
    expect(
      resolveAuthMode({
        googleClientId: '',
        devBypass: false,
        localhostBypass: true,
        authUrl: 'http://127.0.0.1:3000',
        queueDriver: 'local',
        nodeEnv: 'production',
      }),
    ).toBe('dev-bypass');
  });

  it('rejects the localhost bypass for non-loopback and cloud configurations', () => {
    expect(() =>
      resolveAuthMode({
        googleClientId: '',
        devBypass: false,
        localhostBypass: true,
        authUrl: 'https://assistant.example.com',
        queueDriver: 'local',
        nodeEnv: 'production',
      }),
    ).toThrow('requires a loopback AUTH_URL');
    expect(() =>
      resolveAuthMode({
        googleClientId: '',
        devBypass: false,
        localhostBypass: true,
        authUrl: 'http://localhost:3000',
        queueDriver: 'cloudtasks',
        nodeEnv: 'production',
      }),
    ).toThrow('requires a loopback AUTH_URL');
  });

  it('uses Google auth when it is configured', () => {
    expect(
      resolveAuthMode({ googleClientId: 'client-id', devBypass: false, nodeEnv: 'production' }),
    ).toBe('google');
  });
});
