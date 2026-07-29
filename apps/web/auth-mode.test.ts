import { describe, expect, it } from 'vitest';
import { requestLooksLoopback, resolveAuthMode } from './auth-mode.js';

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

describe('requestLooksLoopback', () => {
  const request = (overrides: Partial<Parameters<typeof requestLooksLoopback>[0]>) =>
    requestLooksLoopback({ host: null, forwardedFor: null, forwardedHost: null, ...overrides });

  it('accepts direct loopback requests, with and without ports', () => {
    expect(request({ host: 'localhost:3000' })).toBe(true);
    expect(request({ host: '127.0.0.1:3000' })).toBe(true);
    expect(request({ host: '[::1]:3000' })).toBe(true);
    expect(request({ host: 'localhost' })).toBe(true);
  });

  it('accepts self-mirrored forwarded headers that still name loopback', () => {
    expect(
      request({
        host: 'localhost:3000',
        forwardedFor: '127.0.0.1',
        forwardedHost: 'localhost:3000',
      }),
    ).toBe(true);
    expect(request({ host: '127.0.0.1:3000', forwardedFor: '::1' })).toBe(true);
  });

  it('rejects a request whose Host names the machine on the network', () => {
    expect(request({ host: '192.168.1.20:3000' })).toBe(false);
    expect(request({ host: 'assistant.example.com' })).toBe(false);
    expect(request({ host: null })).toBe(false);
  });

  it('rejects proxied requests whose forwarded values crossed the network', () => {
    expect(request({ host: 'localhost:3000', forwardedFor: '203.0.113.9' })).toBe(false);
    expect(request({ host: 'localhost:3000', forwardedHost: 'assistant.example.com' })).toBe(false);
    // A spoofed loopback Host cannot rescue a forwarded chain that starts remote.
    expect(request({ host: '127.0.0.1', forwardedFor: '203.0.113.9, 127.0.0.1' })).toBe(false);
  });

  it('KNOWN LIMITATION: a fully crafted loopback header set passes (not a boundary)', () => {
    // A determined attacker who can reach the port sends Host: localhost and
    // X-Forwarded-For: 127.0.0.1, which Next preserves — byte-identical to a
    // genuine local request. This check cannot distinguish them; the real
    // control is binding the port to loopback. Pinned so the limitation is
    // explicit and any future "fix" that claims to close it is scrutinised.
    expect(request({ host: 'localhost', forwardedFor: '127.0.0.1' })).toBe(true);
  });
});
