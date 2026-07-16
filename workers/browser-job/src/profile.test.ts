import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseJobInput } from './input.js';
import { decryptProfile, encryptProfile } from './profile.js';

describe('profile encryption', () => {
  const key = randomBytes(32).toString('hex');

  it('round-trips', () => {
    const data = randomBytes(4096);
    const sealed = encryptProfile(data, key);
    expect(sealed.length).toBe(12 + 16 + data.length);
    expect(decryptProfile(sealed, key).equals(data)).toBe(true);
  });

  it('fails closed on a wrong key or tampered payload', () => {
    const sealed = encryptProfile(Buffer.from('cookies'), key);
    expect(() => decryptProfile(sealed, randomBytes(32).toString('hex'))).toThrow();
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    expect(() => decryptProfile(tampered, key)).toThrow();
  });

  it('rejects short keys', () => {
    expect(() => encryptProfile(Buffer.from('x'), 'abcd')).toThrow(/32 bytes/);
  });
});

describe('parseJobInput', () => {
  const valid = {
    taskId: 't1',
    callbackUrl: 'http://localhost:8787/webhooks/browser/callback',
    callbackToken: 'tok',
    plan: { goal: 'g', rung: 'headless', steps: [{ action: 'goto', url: 'https://x.test' }] },
    storage: { driver: 'local', root: '/tmp/ws' },
  };

  it('accepts a complete input', () => {
    expect(parseJobInput(JSON.stringify(valid)).taskId).toBe('t1');
  });

  it.each([
    ['missing env', undefined, /not set/],
    ['no token', JSON.stringify({ ...valid, callbackToken: '' }), /callbackToken/],
    ['no steps', JSON.stringify({ ...valid, plan: { ...valid.plan, steps: [] } }), /steps/],
    ['no storage', JSON.stringify({ ...valid, storage: undefined }), /storage/],
  ])('rejects %s', (_label, raw, pattern) => {
    expect(() => parseJobInput(raw as string | undefined)).toThrow(pattern);
  });
});
